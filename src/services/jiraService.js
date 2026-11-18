// ==========================================
// Jira Business Logic & Metadata Service
// ==========================================

const { jiraGet } = require("../jiraClient");

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

module.exports = {
    getAvailableLinkTypes,
    getProjectComponents,
    getAvailableFields,
    getDefaultNonSubtaskIssueTypeId
};