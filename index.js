#!/usr/bin/env node
const axios = require("axios");
const dotenv = require("dotenv");
const FormData = require("form-data");
const AdmZip = require("adm-zip");
const { readFileSync } = require('fs');
const { join, dirname } = require('path');

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

// ===== HELPERS =====
async function jiraGet(path) {
    const response = await axios.get(`${JIRA_BASE}${path}`, { headers });
    return response.data;
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

// Allow JIRA unsupported attachment types by zipping them first
async function cloneAttachments(srcIssue, newIssueKey) {
    const attachments = srcIssue.fields.attachment || [];

    for (const att of attachments) {
        console.log(`📂 Processing attachment: ${att.filename}`);

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
            // Axios handles the multipart upload correctly
            const response = await axios.post(
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
            console.log(`✅ Uploaded attachment: ${uploadName}`);
        } catch (err) {
            console.error(`❌ Failed to upload ${uploadName}:`, err.response?.data || err.message);
        }
    }
}

// Atlassian Document Format (ADF)
function sanitizeADF(adf) {
    if (!adf || adf.type !== "doc") return { type: "doc", version: 1, content: [] };

    const unsupported = new Set(["mediaSingle", "media", "mediaInline", "inlineCard", "blockCard", "mention"]);

    function cleanContent(content) {
        return content
        .map(node => {
            if (!node) return null;

            // remove unsupported node types
            if (unsupported.has(node.type)) return null;
            // if (node.type === "mediaGroup" && (!node.content || node.content.length === 0)) return null;

            // recursively clean children first
            if (node.content) node.content = cleanContent(node.content);

            // remove mediaGroup (empty OR only contained unsupported nodes)
            if ( node.type === "mediaGroup" && (!node.content || node.content.length === 0) ) { return null; }

            return node;
        })
        .filter(Boolean);
    }

    return {
        ...adf,
        content: cleanContent(adf.content || []),
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

    const sanitizedDescription = sanitizeADF(src.fields.description);

    const baseFields = {
        summary: src.fields.summary,
        description: sanitizedDescription,
        issuetype: { id: src.fields.issuetype.id },
        assignee: src.fields.assignee ? { id: src.fields.assignee.accountId } : undefined,
    };

    // 2. Create clones in each target project
    for (const target of TARGETS) {
        const originalSummary = src.fields.summary;
        const convertedSummary = transformSummaryForTarget(target, originalSummary);

        const fields = {
            ...baseFields,
            summary: convertedSummary,
            project: { key: target.project },
            fixVersions: target.affectsVersions.map((v) => ({ name: v })),
            versions: (baseFields.issuetype.id !== "10011") ? (target.affectsVersions.map((v) => ({ name: v }))) : undefined,
            ...(target.labels && target.labels.length > 0
                ? { labels: target.labels }
                : {}),
            ...(target.components && target.components.length > 0
                ? { components: target.components.map((v) => ({ name: v })) }
                : {}),
        };

        try {
            const newIssue = await jiraPost("/rest/api/3/issue", { fields });
            console.log(`✅ Created clone ${newIssue.key} in project ${target.project} (fixVersions: ${target.affectsVersions.join(", ")})`);
            await cloneAttachments(src, newIssue.key);
            try {
                await jiraPost("/rest/api/3/issueLink", {
                    type: { name: "Blocks" },
                    inwardIssue: { key: SOURCE_ISSUE_KEY },
                    outwardIssue: { key: newIssue.key }
                });
                console.log(`🔗 Linked ${SOURCE_ISSUE_KEY} blocks ${newIssue.key}`);
            } catch (linkErr) {
                console.error(`❌ Failed to link ${SOURCE_ISSUE_KEY} to ${newIssue.key}:`, linkErr.message);
            }
            await sleep(1000); // Add a 1 second delay between clones
        } catch (err) {
            console.error(`❌ Failed to create clone in ${target.project}:`, err.message);
        }
    }

}

run().catch((err) => console.error("❌ Error:", err, err.message));