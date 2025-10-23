import fetch from "node-fetch";
import dotenv from "dotenv";
import axios from "axios";
import FormData from "form-data";
import AdmZip from "adm-zip";
dotenv.config();

import { TARGETS } from "./components/targets.js";

// ===== CONFIGURATION =====
const JIRA_BASE = process.env.JIRA_BASE;
const API_USER = process.env.JIRA_USER;
const API_TOKEN = process.env.JIRA_TOKEN;
const SOURCE_ISSUE_KEY = "<SOURCE_ISSUE_KEY>"; // issue you want to clone

const headers = {
    "Content-Type": "application/json",
    Authorization: "Basic " + Buffer.from(`${API_USER}:${API_TOKEN}`).toString("base64"),
};

// ===== HELPERS =====
async function jiraGet(path) {
    const res = await fetch(`${JIRA_BASE}${path}`, { headers });
    if (!res.ok) throw new Error(await res.text());
    return res.json();
}

async function jiraPost(path, body, extraHeaders = {}) {
    const res = await fetch(`${JIRA_BASE}${path}`, {
        method: "POST",
        headers: { ...headers, ...extraHeaders },
        body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error(await res.text());
    const text = await res.text();
    return text ? JSON.parse(text) : {};
}

// Allow JIRA unsupported attachment types by zipping them first
async function cloneAttachments(srcIssue, newIssueKey) {
    const attachments = srcIssue.fields.attachment || [];

    for (const att of attachments) {
        console.log(`📂 Processing attachment: ${att.filename}`);

        // Download the attachment from Jira
        const res = await fetch(att.content, { headers });
        const buffer = Buffer.from(await res.arrayBuffer());

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