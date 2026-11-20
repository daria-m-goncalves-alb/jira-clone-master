// ==========================================
// Jira Business Logic & Metadata Service
// ==========================================

const { jiraGet, jiraPost } = require("../jiraClient");
const { extractMediaIds, rewriteMediaIds } = require("../utils/adfTransformer");

async function getComments(issueKey) {
    const comments = new Map();
    let startAt = 0;
    try {
        while (true) {
            const page = await jiraGet(`/rest/api/3/issue/${issueKey}/comment?orderBy=created&expand=properties&maxResults=100&startAt=${startAt}`);
            for (const comment of page.comments) {
                const internal = comment.properties?.find(p => p.key === "sd.public.comment")?.value?.internal;
                if (comment.jsdPublic === false || internal === true || internal === "true") {
                    console.warn(`Skipped internal service desk comment ${comment.id} on ${issueKey}.`);
                    continue;
                }
                comments.set(comment.id, comment);
            }
            startAt += page.comments.length;
            if (!page.comments.length || startAt >= page.total) break;
        }
    } catch (err) {
        console.warn(`Could not read all comments from ${issueKey}:`, err.response?.data || err.message);
    }
    return [...comments.values()];
}

async function cloneComments(issueKey, comments, mediaIdMap) {
    let copied = 0;
    for (const { id, body, visibility } of comments) {
        try {
            if (extractMediaIds(body).some(mediaId => !mediaIdMap.has(mediaId))) {
                throw new Error("An embedded attachment could not be mapped to the clone.");
            }
            await jiraPost(`/rest/api/3/issue/${issueKey}/comment`, {
                body: rewriteMediaIds(body, mediaIdMap),
                ...(visibility && { visibility })
            });
            copied++;
        } catch (err) {
            console.warn(`Could not copy comment ${id} to ${issueKey}:`, err.response?.data || err.message);
        }
    }
    console.log(`Copied ${copied} of ${comments.length} eligible comments to ${issueKey}.`);
}

function matchesStatus(actual, expected) {
    return (expected.id && actual?.id === expected.id) ||
        (expected.name && actual?.name?.toLowerCase() === expected.name.toLowerCase());
}

function transitionTo(transitions, status) {
    return transitions.find(t => status.id && t.to?.id === status.id) ??
        transitions.find(t => matchesStatus(t.to, status));
}

async function getStatusHistory(sourceKey) {
    const statuses = [];
    let startAt = 0;
    while (true) {
        const page = await jiraGet(`/rest/api/3/issue/${sourceKey}/changelog?startAt=${startAt}&maxResults=100`);
        for (const change of page.values) {
            for (const item of change.items) {
                if (item.fieldId === "status" || item.field === "status") {
                    statuses.push({ id: item.to, name: item.toString });
                }
            }
        }
        startAt += page.values.length;
        if (page.isLast || !page.values.length || startAt >= page.total) return statuses;
    }
}

async function copyStatus(issueKey, sourceStatus, sourceKey) {
    if (!sourceStatus?.name) {
        console.warn(`Could not match status for ${issueKey}: source status is missing.`);
        return;
    }

    const path = `/rest/api/3/issue/${issueKey}`;
    let current;
    try {
        const readStatus = async () => (await jiraGet(`${path}?fields=status`)).fields.status;
        current = await readStatus();

        let history;
        const visited = new Set();
        while (!matchesStatus(current, sourceStatus)) {
            if (visited.has(current.id ?? current.name)) {
                console.warn(`Stopped matching ${issueKey} to "${sourceStatus.name}" because Jira returned to "${current.name}".`);
                return;
            }
            visited.add(current.id ?? current.name);
            const { transitions } = await jiraGet(`${path}/transitions`);
            let match = transitionTo(transitions, sourceStatus);
            if (!match && transitions.length) {
                history ??= await getStatusHistory(sourceKey);
                // Jump to the latest reachable point on the source issue's route.
                const forward = transitions.filter(t => !visited.has(t.to?.id ?? t.to?.name));
                for (let i = history.length - 1; i >= 0; i--) {
                    const status = history[i];
                    if (matchesStatus(current, status)) break;
                    match = transitionTo(forward, status);
                    if (match) {
                        history = history.slice(i + 1);
                        break;
                    }
                }
            }
            if (!match) {
                const options = transitions.map(t => t.to?.name).filter(Boolean).join(", ") || "none";
                console.warn(`${issueKey} is in "${current.name}". No available route from the source history to "${sourceStatus.name}". Available destinations: ${options}.`);
                return;
            }
            await jiraPost(`${path}/transitions`, { transition: { id: match.id } });
            current = await readStatus();
        }
        console.log(`${issueKey} final status: "${current.name}".`);
    } catch (err) {
        console.warn(`Could not match ${issueKey} to "${sourceStatus.name}" (last known status: ${current?.name ?? "unknown"}):`, err.response?.data || err.message);
    }
}

async function getWebLinks(issueKey) {
    try {
        const links = await jiraGet(`/rest/api/3/issue/${issueKey}/remotelink`);
        return links.filter(link => !link.application?.type);
    } catch (err) {
        console.warn(`Could not read web links from ${issueKey}:`, err.response?.data || err.message);
        return [];
    }
}

async function cloneWebLinks(issueKey, links) {
    for (const { globalId, application, relationship, object } of links) {
        try {
            await jiraPost(`/rest/api/3/issue/${issueKey}/remotelink`, {
                globalId, application, relationship, object
            });
        } catch (err) {
            console.warn(`Could not copy web link "${object?.title}" to ${issueKey}:`, err.response?.data || err.message);
        }
    }
}

// Get available link types
async function getAvailableLinkTypes() {
    try {
        const data = await jiraGet('/rest/api/3/issueLinkType');
        const linkTypes = data.issueLinkTypes || [];
        console.log(`\n🔗 Available link types in your Jira instance:\n`);
        linkTypes.forEach(lt => {
            console.log(` Name: "${lt.name}"`);
            console.log(`Inward: ${lt.inward}`);
            console.log(`Outward: ${lt.outward}\n`);
        });
        return linkTypes;
    } catch (err) {
        console.warn(`⚠️ Could not fetch link types:`, err.message);
        return [];
    }
}

async function getProjectComponents(projectKey) {
    try {
        const components = await jiraGet(`/rest/api/3/project/${projectKey}/components`);
        return new Set(components.map(c => c.name));
    } catch (err) {
        console.warn(`⚠️ Could not fetch components for ${projectKey}:`, err.message);
        return new Set();
    }
}

async function getAvailableFields(projectKey, issueTypeId) {
    try {
        const metadata = await jiraGet(`/rest/api/3/issue/createmeta?projectKeys=${projectKey}&expand=projects.issuetypes.fields`);
        const project = metadata.projects?.[0];
        const issueType = project?.issuetypes?.find(it => it.id === issueTypeId);
        const fields = issueType?.fields || {};
        
        // Log custom fields for debugging if needed
        const customFields = Object.entries(fields)
            .filter(([key]) => key.startsWith('customfield'))
            .reduce((acc, [key, val]) => {
                acc[key] = val.name;
                return acc;
            }, {});

        return fields;
    } catch (err) {
        console.warn(`⚠️ Could not fetch create metadata for project ${projectKey}:`, err.message);
        return {};
    }
}

async function getDefaultNonSubtaskIssueTypeId(projectKey) {
    try {
        const metadata = await jiraGet(`/rest/api/3/issue/createmeta?projectKeys=${projectKey}&expand=projects.issuetypes`);
        const issueTypes = metadata.projects?.[0]?.issuetypes || [];

        // Prefer Story if available, otherwise first non-subtask type
        const storyType = issueTypes.find(it => !it.subtask && /story/i.test(it.name));
        if (storyType) return storyType.id;

        const defaultType = issueTypes.find(it => !it.subtask);
        return defaultType ? defaultType.id : null;
    } catch (err) {
        console.warn(`⚠️ Could not fetch issue types for project ${projectKey}:`, err.message);
        return null;
    }
}

async function getSubtaskIssueTypes(projectKey) {
    const subtaskTypes = [];
    let startAt = 0;

    while (true) {
        const page = await jiraGet(
            `/rest/api/3/issue/createmeta/${encodeURIComponent(projectKey)}/issuetypes?startAt=${startAt}`
        );
        subtaskTypes.push(...page.issueTypes.filter(type => type.subtask));
        startAt += page.issueTypes.length;
        if (startAt >= page.total || page.issueTypes.length === 0) return subtaskTypes;
    }
}

module.exports = {
    getComments,
    cloneComments,
    copyStatus,
    getWebLinks,
    cloneWebLinks,
    getAvailableLinkTypes,
    getProjectComponents,
    getAvailableFields,
    getDefaultNonSubtaskIssueTypeId,
    getSubtaskIssueTypes
};