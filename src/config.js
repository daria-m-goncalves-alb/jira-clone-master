const { readFileSync } = require('fs');
const { join, dirname } = require('path');
const dotenv = require('dotenv');

dotenv.config();

const scriptDir = process.pkg ? dirname(process.execPath) : join(__dirname, '..');

function loadTargets() {
    try {
        const targetsPath = join(scriptDir, 'targets.json');
        return JSON.parse(readFileSync(targetsPath, 'utf8'));
    } catch (error) {
        console.error("❌ Error: Could not load targets.json configuration file");
        console.error(`Expected location: ${join(scriptDir, 'targets.json')}`);
        console.error("Error details:", error.message);
        process.exit(1);
    }
}

const SOURCE_ISSUE_KEY = process.argv[2];

if (!SOURCE_ISSUE_KEY && process.argv[3] !== '--show-links') {
    console.error("❌ Error: Please provide the source issue key as an argument");
    console.error("Usage: node index.js <SOURCE_ISSUE_KEY>");
    process.exit(1);
}

if (!process.env.JIRA_BASE || !process.env.JIRA_USER || !process.env.JIRA_TOKEN) {
    console.error("❌ Error: Missing required environment variables (.env)");
    process.exit(1);
}

module.exports = {
    JIRA_BASE: process.env.JIRA_BASE,
    API_USER: process.env.JIRA_USER,
    API_TOKEN: process.env.JIRA_TOKEN,
    SOURCE_ISSUE_KEY,
    TARGETS: loadTargets()
};