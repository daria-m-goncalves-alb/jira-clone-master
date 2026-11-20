#!/usr/bin/env node
const axios = require("axios");
const { SOURCE_ISSUE_KEY, SAME_STATUS, COPY_COMMENTS, SHOW_LINKS, TARGETS } = require("./src/config");
const { JIRA_BASE, headers, jiraGet, jiraPost } = require("./src/jiraClient");
const {
    getAvailableLinkTypes,
    getProjectComponents,
    getAvailableFields,
    getDefaultNonSubtaskIssueTypeId,
    getSubtaskIssueTypes,
    copyStatus,
    getComments,
    cloneComments,
    getWebLinks,
    cloneWebLinks
} = require("./src/services/jiraService");
const {
    sanitizeADF,
    extractMediaIds,
    normalizeADF,
    rewriteMediaIds,
    forceBlockADF,
    finalJiraADF
} = require("./src/utils/adfTransformer");
const {
    downloadImageAttachments,
    uploadImages,
    cloneRemainingAttachments
} = require("./src/utils/attachmentHandler");
const { transformSummaryForTarget, sleep } = require("./src/utils/helpers");

async function cloneIssue(src, target, webLinks, comments, parentKey, issueTypeId) {
    const originalSummary = src.fields.summary;
    const convertedSummary = transformSummaryForTarget(target, originalSummary);

    // Determine target issue type: convert sub-task to Story if configured or auto-resolve
    let targetIssueTypeId = issueTypeId ?? src.fields.issuetype.id;

    if (!parentKey && src.fields.issuetype?.subtask) {
        if (target.subtaskToStoryTypeId) {
            targetIssueTypeId = target.subtaskToStoryTypeId;
            console.log(`ℹ️ Source is sub-task; using configured target.subtaskToStoryTypeId=${targetIssueTypeId} for ${target.project}`);
        } else {
            const fallbackTypeId = await getDefaultNonSubtaskIssueTypeId(target.project);
            if (fallbackTypeId) {
                targetIssueTypeId = fallbackTypeId;
                console.log(`ℹ️ Source is sub-task; auto-mapped to non-subtask issueTypeId=${targetIssueTypeId} for ${target.project}`);
            } else {
                console.error(`❌ Could not map sub-task issue type for ${target.project}. Add target.subtaskToStoryTypeId to your targets.json.`);
                return;
            }
        }
    }

    // Get available fields for this issue type in the target project
    const [availableFields, targetComponentNames] = await Promise.all([
        getAvailableFields(target.project, targetIssueTypeId),
        getProjectComponents(target.project),
    ]);

    // Base fields - always required
    const fields = {
        summary: convertedSummary,
        issuetype: { id: targetIssueTypeId },
        project: { key: target.project },
    };

    if (parentKey) fields.parent = { key: parentKey };

    // Fields to copy from source issue (by default), can be overridden by target config
    const fieldsToPreserve = {
        assignee: () => src.fields.assignee ? { id: src.fields.assignee.accountId } : null,
        labels: () => src.fields.labels && src.fields.labels.length > 0 ? src.fields.labels : null,
        components: () => {
            if (!src.fields.components || src.fields.components.length === 0) return null;
            const valid = src.fields.components.filter(c => targetComponentNames.has(c.name)).map(c => ({ name: c.name }));
            return valid.length > 0 ? valid : null;
        },
        priority: () => src.fields.priority ? { id: src.fields.priority.id } : null,
        reporter: () => src.fields.reporter ? { id: src.fields.reporter.accountId } : null,
    };

    // Copy preserved fields if available in target
    for (const [fieldName, getValue] of Object.entries(fieldsToPreserve)) {
        if (availableFields[fieldName]) {
            const value = getValue();
            if (value) {
                fields[fieldName] = value;
            }
        }
    }

    // Override with target-specific configurations
    if (target.affectsVersions && target.affectsVersions.length > 0) {
        const versionField = availableFields.versions ? 'versions' : (availableFields.fixVersions ? 'fixVersions' : null);
        if (versionField) {
            fields[versionField] = target.affectsVersions.map((v) => ({ name: v }));
        }
    }

    if (target.fixVersions && target.fixVersions.length > 0 && availableFields.fixVersions) {
        fields.fixVersions = target.fixVersions.map((v) => ({ name: v }));
    }

    if (target.labels && target.labels.length > 0 && availableFields.labels) {
        fields.labels = target.labels;
    }

    if (target.components && target.components.length > 0 && availableFields.components) {
        fields.components = target.components.map((v) => ({ name: v }));
    }

    // Copy any custom fields from source that are available in target
    const standardFields = new Set(['summary', 'issuetype', 'project', 'parent', 'assignee', 'labels', 'components', 'versions', 'fixVersions']);
    for (const [fieldKey, fieldValue] of Object.entries(src.fields)) {
        if (!standardFields.has(fieldKey) && availableFields[fieldKey] && fieldValue) {
            if (typeof fieldValue === 'string' || typeof fieldValue === 'number' || typeof fieldValue === 'boolean') {
                fields[fieldKey] = fieldValue;
            } else if (Array.isArray(fieldValue) && fieldValue.length > 0 && typeof fieldValue[0] === 'string') {
                fields[fieldKey] = fieldValue;
            }
        }
    }

    let newIssue;
    try {
        // Create issue WITHOUT description initially to avoid stale attachment references
        newIssue = await jiraPost("/rest/api/3/issue", { fields });
        console.log(`✅ Created clone ${newIssue.key} in project ${target.project}`);
        await cloneWebLinks(newIssue.key, webLinks);

        // --- INLINE IMAGE SAFE DESCRIPTION CLONE ---
        const sourceDescription = sanitizeADF(src.fields.description);

        // 1. Extract media IDs
        const mediaIds = extractMediaIds(sourceDescription).concat(comments.flatMap(c => extractMediaIds(c.body)));

        // 2. Download images
        const { images, embeddedAttachmentIds } = await downloadImageAttachments(src, mediaIds);

        // 3. Upload images first
        const mediaIdMap = await uploadImages(newIssue.key, images);
        await sleep(500); // Jira attachment indexing delay
        if (COPY_COMMENTS) await cloneComments(newIssue.key, comments, mediaIdMap);

        // 4. Rewrite ADF with new attachment IDs
        const rewrittenDescription = finalJiraADF(
            forceBlockADF(
                normalizeADF(
                    rewriteMediaIds(sourceDescription, mediaIdMap)
                )
            )
        );

        // 5. Update description
        try {
            await axios.put(
                `${JIRA_BASE}/rest/api/3/issue/${newIssue.key}`,
                { fields: { description: rewrittenDescription } },
                { headers }
            );
            console.log(`✅ Description with images updated in ${newIssue.key}`);
        } catch (err) {
            console.error(
                `❌ Failed to update description in ${newIssue.key}:`,
                err.response?.data || err.message
            );
        }

        await cloneRemainingAttachments(src, newIssue.key, embeddedAttachmentIds);

        try {
            // Use link type from target config or default to "Cloners"
            const linkTypeName = target.linkType || "Cloners";

            await jiraPost("/rest/api/3/issueLink", {
                type: { name: linkTypeName },
                inwardIssue: { key: newIssue.key },
                outwardIssue: { key: src.key }
            });
            console.log(`🔗 Linked ${src.key} ${linkTypeName} ${newIssue.key}`);
        } catch (linkErr) {
            if (linkErr.response?.status === 404) {
                console.error(`❌ Link type not found. Run with --show-links to see available link types`);
            } else {
                console.error(`❌ Failed to link ${src.key} to ${newIssue.key}:`, linkErr.response?.data || linkErr.message);
            }
        }
        await sleep(1000); // Add a 1 second delay between clones
    } catch (err) {
        if (newIssue) {
            console.error(`Failed to finish copying ${src.key} to ${newIssue.key}:`, err.response?.data || err.message);
            return newIssue;
        }
        console.error(`❌ Failed to clone ${src.key} in ${target.project}:`, err.response?.data || err.message);
        console.error(`📋 Request fields:`, JSON.stringify(fields, null, 2));
    }
    return newIssue;
}

async function cloneSubtasks(src, target, parent, subtaskSources) {
    let issueTypes;
    try {
        issueTypes = await getSubtaskIssueTypes(target.project);
    } catch (err) {
        console.error(`Could not get subtask issue types for ${target.project} while cloning children of ${parent.key}:`, err.response?.data || err.message);
        return;
    }
    if (!issueTypes.length) {
        console.warn(`Skipped subtasks for ${parent.key}: no creatable subtask issue types in ${target.project}.`);
        return;
    }

    for (const { key } of src.fields.subtasks) {
        try {
            if (!subtaskSources.has(key)) {
                const issue = await jiraGet(`/rest/api/3/issue/${key}`);
                subtaskSources.set(key, {
                    issue,
                    links: await getWebLinks(issue.key),
                    comments: COPY_COMMENTS ? await getComments(issue.key) : []
                });
            }
            const { issue, links, comments } = subtaskSources.get(key);
            const sourceType = issue.fields.issuetype;
            const targetType = issueTypes.find(type => type.id === sourceType.id)
                ?? issueTypes.find(type => type.name === sourceType.name)
                ?? issueTypes[0];
            const child = await cloneIssue(issue, target, links, comments, parent.key, targetType.id);
            if (SAME_STATUS && child) await copyStatus(child.key, issue.fields.status, issue.key);
        } catch (err) {
            console.error(`Could not clone subtask ${key} under ${parent.key}:`, err.response?.data || err.message);
        }
    }
}

async function run() {
    if (SHOW_LINKS) return getAvailableLinkTypes();
    console.log(`Cloning issue: ${SOURCE_ISSUE_KEY}`);
    const src = await jiraGet(`/rest/api/3/issue/${SOURCE_ISSUE_KEY}`);
    const webLinks = await getWebLinks(src.key);
    const comments = COPY_COMMENTS ? await getComments(src.key) : [];
    const subtaskSources = new Map();

    for (const target of TARGETS) {
        const parent = await cloneIssue(src, target, webLinks, comments);
        if (!parent) continue;

        if (src.fields.subtasks?.length) await cloneSubtasks(src, target, parent, subtaskSources);
        if (SAME_STATUS) await copyStatus(parent.key, src.fields.status, src.key);
    }
}

run().catch(err => {
    console.error("Clone Master failed:", err.response?.data || err.message);
    process.exitCode = 1;
});