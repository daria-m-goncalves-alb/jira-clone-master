import fetch from "node-fetch";
import dotenv from "dotenv";
dotenv.config();

import { TARGETS } from "./components/targets.js";

// ===== CONFIGURATION =====
const JIRA_BASE = process.env.JIRA_BASE;
const API_USER = process.env.JIRA_USER;
const API_TOKEN = process.env.JIRA_TOKEN;
const SOURCE_ISSUE_KEY = "NBWEBTI-1445"; // issue you want to clone

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

// ===== MAIN LOGIC =====
async function run() {
    // 1. Fetch the source issue
    const src = await jiraGet(`/rest/api/3/issue/${SOURCE_ISSUE_KEY}`);

    const baseFields = {
        summary: src.fields.summary,
        description: src.fields.description,
        issuetype: { id: src.fields.issuetype.id },
        assignee: src.fields.assignee ? { id: src.fields.assignee.accountId } : undefined,
    };

    // 2. Create clones in each target project
    for (const target of TARGETS) {
        const originalSummary = src.fields.summary;
        const summaryWithoutFirstGroup = originalSummary.replace(/^\[[^\]]*\]\s*/, "");
        const newSummary = `[${target.client}] ${summaryWithoutFirstGroup}`;

        const fields = {
            ...baseFields,
            summary: newSummary,
            project: { key: target.project },
            fixVersions: target.affectsVersions.map((v) => ({ name: v })),
            versions: target.affectsVersions.map((v) => ({ name: v })),
            labels: target.labels,
            ...(target.components && target.components.length > 0
                ? { components: target.components.map((v) => ({ name: v })) }
                : {}),
        };

        try {
            const newIssue = await jiraPost("/rest/api/3/issue", { fields });
            console.log(`✅ Created clone ${newIssue.key} in project ${target.project} (fixVersions: ${target.affectsVersions.join(", ")})`);
            
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
        } catch (err) {
            console.error(`❌ Failed to create clone in ${target.project}:`, err.message);
        }
    }

}

run().catch((err) => console.error("❌ Error:", err.message));