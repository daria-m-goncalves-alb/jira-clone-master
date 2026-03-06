#!/usr/bin/env node
const axios = require("axios");
const dotenv = require("dotenv");
const FormData = require("form-data");
const AdmZip = require("adm-zip");
const { readFileSync } = require('fs');
const { join, dirname } = require('path');
let mediaIdMap = new Map();

dotenv.config();

// Get the directory where the executable/script is located
const scriptDir = process.pkg ? dirname(process.execPath) : __dirname;

// Load targets configuration from external file
let TARGETS;
try {
    const targetsPath = join(scriptDir, 'targets.json');
    const targetsData = readFileSync(targetsPath, 'utf8');
    TARGETS = JSON.parse(targetsData);
} catch (error) {
    console.error("❌ Error: Could not load targets.json configuration file");
    console.error("Please ensure targets.json exists in the same directory as the executable");
    console.error(`Expected location: ${join(scriptDir, 'targets.json')}`);
    console.error("Error details:", error.message);
    process.exit(1);
}

// ===== CONFIGURATION =====
const JIRA_BASE = process.env.JIRA_BASE;
const API_USER = process.env.JIRA_USER;
const API_TOKEN = process.env.JIRA_TOKEN;

// Get SOURCE_ISSUE_KEY from command line argument
const SOURCE_ISSUE_KEY = process.argv[2];

// Validate required configuration
if (!SOURCE_ISSUE_KEY) {
    console.error("❌ Error: Please provide the source issue key as an argument");
    console.error("Usage: node index.js <SOURCE_ISSUE_KEY>");
    console.error("Example: node index.js PROJ-123");
    process.exit(1);
}

if (!JIRA_BASE || !API_USER || !API_TOKEN) {
    console.error("❌ Error: Missing required environment variables");
    console.error("Please ensure your .env file contains: JIRA_BASE, JIRA_USER, JIRA_TOKEN");
    process.exit(1);
}

console.log(`🎯 Cloning issue: ${SOURCE_ISSUE_KEY}`);

const headers = {
    "Content-Type": "application/json",
    Authorization: "Basic " + Buffer.from(`${API_USER}:${API_TOKEN}`).toString("base64"),
};

// Check if user wants to see available link types
if (process.argv[3] === '--show-links') {
    getAvailableLinkTypes().then(() => process.exit(0));
}

// ===== HELPERS =====
async function jiraGet(path) {
    const response = await axios.get(`${JIRA_BASE}${path}`, { headers });
    return response.data;
}

// Get available link types
async function getAvailableLinkTypes() {
    try {
        const data = await jiraGet('/rest/api/3/issueLinkType');
        const linkTypes = data.issueLinkTypes || [];
        console.log(`\n🔗 Available link types in your Jira instance:\n`);
        linkTypes.forEach(lt => {
            console.log(`  Name: "${lt.name}"`);
            console.log(`    Inward: ${lt.inward}`);
            console.log(`    Outward: ${lt.outward}\n`);
        });
        return linkTypes;
    } catch (err) {
        console.warn(`⚠️ Could not fetch link types:`, err.message);
        return [];
    }
}
async function getAvailableFields(projectKey, issueTypeId) {
    try {
        const metadata = await jiraGet(`/rest/api/3/issue/createmeta?projectKeys=${projectKey}&expand=projects.issuetypes.fields`);
        const project = metadata.projects?.[0];
        const issueType = project?.issuetypes?.find(it => it.id === issueTypeId);
        const fields = issueType?.fields || {};
        
        // Log custom fields for debugging
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

// Real jiraPost function - comment for testing with dummy
async function jiraPost(path, body, extraHeaders = {}) {
    const response = await axios.post(`${JIRA_BASE}${path}`, body, {
        headers: { ...headers, ...extraHeaders }
    });
    return response.data || {};
}

// Dummy jiraPost function for testing
// async function jiraPost(path, body, extraHeaders = {}) {
//     console.log(`🧪 DUMMY API CALL: POST ${JIRA_BASE}${path}`);
//     console.log(`📋 Request Body:`, JSON.stringify(body, null, 2));
    
//     // Simulate API delay
//     await new Promise(resolve => setTimeout(resolve, 100));
    
//     // Mock responses based on the path
//     if (path === "/rest/api/3/issue") {
//         // Mock issue creation response
//         const mockKey = `TEST-${Math.floor(Math.random() * 1000)}`;
//         console.log(`🎭 Mock Response: Created issue ${mockKey}`);
//         return {
//             key: mockKey,
//             id: Math.floor(Math.random() * 100000).toString(),
//             self: `${JIRA_BASE}/rest/api/3/issue/${mockKey}`
//         };
//     } else if (path === "/rest/api/3/issueLink") {
//         // Mock issue link response
//         console.log(`🎭 Mock Response: Created link between ${body.inwardIssue.key} and ${body.outwardIssue.key}`);
//         return {};
//     } else {
//         // Generic mock response
//         console.log(`🎭 Mock Response: Success`);
//         return {};
//     }
// }

// 🔗 Available link types in your Jira instance:
//   Name: "Blocks" - Inward: is blocked by / Outward: blocks
//   Name: "Cloners" - Inward: is cloned by / Outward: clones
//   Name: "Defect" - Inward: created by / Outward: created
//   Name: "Duplicate" - Inward: is duplicated by / Outward: duplicates
//   Name: "Issue split" - Inward: split from / Outward: split to
//   Name: "Polaris work item link" - Inward: is implemented by / Outward: implements
//   Name: "Relates" - Inward: relates to / Outward: relates to
//   Name: "Test" - Inward: is tested by / Outward: tests

// Clone non-image attachments (images in description are handled via media nodes)
async function cloneNonImageAttachments(srcIssue, newIssueKey) {
    const attachments = srcIssue.fields.attachment || [];
    const imageExtensions = new Set(['.png', '.jpg', '.jpeg', '.gif', '.bmp', '.svg', '.webp']);

    for (const att of attachments) {
        // Skip image files - they're handled via media nodes in the description
        const fileExt = att.filename.substring(att.filename.lastIndexOf('.')).toLowerCase();
        if (imageExtensions.has(fileExt)) {
            // Only skip if the image was successfully mapped to a media node
            if (mediaIdMap.has(att.id)) {
                console.log(`🖼️ Image already embedded: ${att.filename}`);
                continue;
            }
        }

        // console.log(`📄 Processing non-image attachment: ${att.filename} (ID: ${att.id})`);

        // Download the attachment from Jira
        const response = await axios.get(att.content, {
            headers,
            responseType: 'arraybuffer'
        });
        const buffer = Buffer.from(response.data);

        let uploadBuffer = buffer;
        let uploadName = att.filename;

        // Zip unsupported file types
        const unsupported = [".msg",".eml",".exe",".dll",".bat",".cmd",".sh",".ini",".sys",".db",".log"];
        if (unsupported.some(ext => att.filename.toLowerCase().endsWith(ext))) {
            console.log(`⚠️ Zipping unsupported file: ${att.filename}`);
            const zip = new AdmZip();
            zip.addFile(att.filename, buffer);
            uploadBuffer = zip.toBuffer();
            uploadName = `${att.filename}.zip`;
        }

        // Create FormData
        const form = new FormData();
        form.append("file", uploadBuffer, uploadName);

        try {
            await axios.post(
                `${JIRA_BASE}/rest/api/3/issue/${newIssueKey}/attachments`,
                form,
                {
                    headers: {
                        Authorization: headers.Authorization,
                        "X-Atlassian-Token": "no-check",
                        ...form.getHeaders(),
                    },
                    maxContentLength: Infinity,
                    maxBodyLength: Infinity,
                }
            );
            // console.log(`✅ Uploaded non-image attachment: ${uploadName}`);
        } catch (err) {
            console.error(`❌ Failed to upload ${uploadName}:`, err.response?.data || err.message);
        }
    }
}

function extractMediaIds(adf) {
    const mediaIds = new Set();

    function walk(nodes = []) {
        for (const node of nodes) {
            if (!node) continue;

            if (
                node.type === "media" &&
                node.attrs?.id &&
                node.attrs?.type === "file"
            ) {
                mediaIds.add(node.attrs.id);
            }

            if (node.content) walk(node.content);
        }
    }

    if (adf?.content) walk(adf.content);
    return [...mediaIds];
}

async function downloadImageAttachments(srcIssue, mediaIds) {
    const images = new Map();

    const attachments = srcIssue.fields.attachment || [];
    for (const att of attachments) {
        if (mediaIds.includes(att.id)) {
            const res = await axios.get(att.content, {
                headers,
                responseType: "arraybuffer"
            });

            images.set(att.id, {
                filename: att.filename,
                buffer: Buffer.from(res.data),
                mimeType: att.mimeType
            });
        }
    }

    return images;
}

async function uploadImages(newIssueKey, images) {
    const idMap = new Map();

    for (const [oldId, img] of images.entries()) {
        const form = new FormData();
        form.append("file", img.buffer, img.filename);

        const res = await axios.post(
            `${JIRA_BASE}/rest/api/3/issue/${newIssueKey}/attachments`,
            form,
            {
                headers: {
                    Authorization: headers.Authorization,
                    "X-Atlassian-Token": "no-check",
                    ...form.getHeaders()
                }
            }
        );

        const newAttachment = res.data?.[0];
        if (newAttachment?.id) {
            idMap.set(oldId, newAttachment.id);
            // console.log(`🖼️ Uploaded image ${img.filename}`);
        }
    }

    return idMap;
}

function normalizeADF(adf) {
    function fixNode(node) {
        if (!node) return null;

        // Paragraph must have content
        if (node.type === "paragraph") {
            if (!node.content || node.content.length === 0) {
                node.content = [{ type: "text", text: " " }];
            }
        }

        // ListItem must contain a paragraph
        if (node.type === "listItem") {
            if (!node.content || node.content.length === 0) {
                node.content = [{
                    type: "paragraph",
                    content: [{ type: "text", text: " " }]
                }];
            }
        }

        // mediaSingle must contain media
        if (node.type === "mediaSingle") {
            if (!node.content || node.content.length === 0) {
                return null;
            }
        }

        if (node.content) {
            node.content = node.content
                .map(fixNode)
                .filter(Boolean);
        }

        return node;
    }

    const content = (adf.content || [])
        .map(fixNode)
        .filter(Boolean);

    return {
        type: "doc",
        version: 1,
        content: content.length
            ? content
            : [{
                type: "paragraph",
                content: [{ type: "text", text: " " }]
            }]
    };
}

function rewriteMediaIds(adf, idMap) {
    function walk(node) {
        if (!node) return null;

        // Rewrite media node IDs
        if (
            node.type === "media" &&
            node.attrs?.id &&
            idMap.has(node.attrs.id)
        ) {
            return {
                ...node,
                attrs: {
                    ...node.attrs,
                    id: idMap.get(node.attrs.id),
                    collection: "jira-issue"
                }
            };
        }

        // Recurse normally — DO NOT drop content
        if (node.content) {
            return {
                ...node,
                content: node.content
                    .map(walk)
                    .filter(Boolean)
            };
        }

        return node;
    }

    return {
        type: "doc",
        version: 1,
        content: (adf.content || [])
            .map(walk)
            .filter(Boolean)
    };
}

function finalJiraADF(adf) {
    const content = [];

    for (const node of adf.content || []) {
        // ❌ hardBreak is INLINE ONLY → drop it
        if (node.type === "hardBreak") continue;

        // ❌ text is INLINE ONLY → wrap
        if (node.type === "text") {
            content.push({
                type: "paragraph",
                content: [node]
            });
            continue;
        }

        // ✅ ensure paragraphs have content
        if (node.type === "paragraph" && (!node.content || node.content.length === 0)) {
            node.content = [{ type: "text", text: " " }];
        }

        content.push(node);
    }

    return {
        type: "doc",
        version: 1,
        content: content.length
            ? content
            : [{
                type: "paragraph",
                content: [{ type: "text", text: " " }]
            }]
    };
}

function forceBlockADF(adf) {
    const blocks = [];

    for (const node of adf.content || []) {
        // Wrap stray text nodes
        if (node.type === "text") {
            blocks.push({
                type: "paragraph",
                content: [node]
            });
            continue;
        }

        // Drop invalid nodes
        if (!node.type) continue;

        // Ensure paragraphs have content
        if (node.type === "paragraph" && (!node.content || node.content.length === 0)) {
            node.content = [{ type: "text", text: " " }];
        }

        blocks.push(node);
    }

    return {
        type: "doc",
        version: 1,
        content: blocks.length
            ? blocks
            : [{
                type: "paragraph",
                content: [{ type: "text", text: " " }]
            }]
    };
}

// Atlassian Document Format (ADF)
function sanitizeADF(adf) {
    if (!adf || adf.type !== "doc") {
        return { type: "doc", version: 1, content: [] };
    }

    function clean(nodes = [], parentType = null) {
        return nodes
            .map(node => {
                if (!node) return null;

                // ❌ remove listItem ONLY if not inside a list
                if (node.type === "listItem" && parentType !== "bulletList" && parentType !== "orderedList") {
                    return null;
                }

                // recursively clean, passing the current node type as parent
                if (node.content) {
                    node.content = clean(node.content, node.type);
                }

                // ❌ remove empty bullet/ordered lists
                if (
                    (node.type === "bulletList" || node.type === "orderedList") &&
                    (!node.content || node.content.length === 0)
                ) {
                    return null;
                }

                return node;
            })
            .filter(Boolean);
    }

    return {
        type: "doc",
        version: 1,
        content: clean(adf.content || [], "doc")
    };
}

function transformSummaryForTarget(target, originalSummary) {
    if (!target || !originalSummary) return originalSummary;

    // if stripBrackets flag is set, remove all [...], including surrounding spaces
    if (target.stripBrackets) {
        return originalSummary.replace(/\s*\[[^\]]*\]/g, '').trim();
    }

    // remove only the first leading [...] group
    const summaryWithoutFirstGroup = originalSummary.replace(/^\s*\[[^\]]*\]\s*/, '');

    // determine client value (support string or array)
    const clientVal = Array.isArray(target.client) ? target.client[0] : target.client;

    // if client present, prefix with it; otherwise just return the summary without first group
    if (clientVal) {
        return `[${clientVal}] ${summaryWithoutFirstGroup}`.trim();
    }

    return summaryWithoutFirstGroup;
}

// Add a delay between clones
function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

// ===== MAIN LOGIC =====
async function run() {
    // Fetch the source issue
    const src = await jiraGet(`/rest/api/3/issue/${SOURCE_ISSUE_KEY}`);

    // 2. Create clones in each target project
    for (const target of TARGETS) {
        const originalSummary = src.fields.summary;
        const convertedSummary = transformSummaryForTarget(target, originalSummary);

        // Get available fields for this issue type in the target project
        const availableFields = await getAvailableFields(target.project, src.fields.issuetype.id);

        // Base fields - always required
        const fields = {
            summary: convertedSummary,
            issuetype: { id: src.fields.issuetype.id },
            project: { key: target.project },
        };

        // Fields to copy from source issue (by default), can be overridden by target config
        const fieldsToPreserve = {
            assignee: () => src.fields.assignee ? { id: src.fields.assignee.accountId } : null,
            labels: () => src.fields.labels && src.fields.labels.length > 0 ? src.fields.labels : null,
            components: () => src.fields.components && src.fields.components.length > 0 ? src.fields.components.map((v) => ({ name: v.name })) : null,
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

        if (target.labels && target.labels.length > 0 && availableFields.labels) {
            fields.labels = target.labels;
        }

        if (target.components && target.components.length > 0 && availableFields.components) {
            fields.components = target.components.map((v) => ({ name: v }));
        }

        // Copy any custom fields from source that are available in target
        // (excluding standard fields and those explicitly set above)
        const standardFields = new Set(['summary', 'issuetype', 'project', 'assignee', 'labels', 'components', 'versions', 'fixVersions']);
        for (const [fieldKey, fieldValue] of Object.entries(src.fields)) {
            if (!standardFields.has(fieldKey) && availableFields[fieldKey] && fieldValue) {
                // Skip if it's a complex object we can't easily copy
                if (typeof fieldValue === 'string' || typeof fieldValue === 'number' || typeof fieldValue === 'boolean') {
                    fields[fieldKey] = fieldValue;
                } else if (Array.isArray(fieldValue) && fieldValue.length > 0 && typeof fieldValue[0] === 'string') {
                    fields[fieldKey] = fieldValue;
                }
            }
        }

        try {
            // Create issue WITHOUT description initially to avoid stale attachment references
            const newIssue = await jiraPost("/rest/api/3/issue", { fields });
            console.log(`✅ Created clone ${newIssue.key} in project ${target.project}`);
            
            // --- INLINE IMAGE SAFE DESCRIPTION CLONE ---

            const sourceDescription = sanitizeADF(src.fields.description);

            // 1. Extract media IDs
            const mediaIds = extractMediaIds(sourceDescription);

            // 2. Download images
            const images = await downloadImageAttachments(src, mediaIds);

            // 3. Upload images first
            mediaIdMap = await uploadImages(newIssue.key, images);
            await sleep(500); // Jira attachment indexing delay

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

            // Clone any non-image file attachments
            await cloneNonImageAttachments(src, newIssue.key);
            
            try {
                // Use link type from target config or default to "Cloners" or "relates to"
                const linkTypeName = target.linkType || "Cloners";
                
                await jiraPost("/rest/api/3/issueLink", {
                    type: { name: linkTypeName },
                    inwardIssue: { key: newIssue.key },
                    outwardIssue: { key: SOURCE_ISSUE_KEY }
                });
                console.log(`🔗 Linked ${SOURCE_ISSUE_KEY} ${linkTypeName} ${newIssue.key}`);
            } catch (linkErr) {
                if (linkErr.response?.status === 404) {
                    console.error(`❌ Link type not found. Run with --show-links to see available link types`);
                } else {
                    console.error(`❌ Failed to link ${SOURCE_ISSUE_KEY} to ${newIssue.key}:`, linkErr.response?.data || linkErr.message);
                }
            }
            await sleep(1000); // Add a 1 second delay between clones
        } catch (err) {
            console.error(`❌ Failed to create clone in ${target.project}:`, err.response?.data || err.message);
            console.error(`📋 Request fields:`, JSON.stringify(fields, null, 2));
        }
    }

}

run().catch((err) => console.error("❌ Error:", err, err.message));