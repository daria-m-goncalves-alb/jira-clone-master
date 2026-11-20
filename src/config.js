const { existsSync, readFileSync } = require('fs');
const { join, dirname } = require('path');
const dotenv = require('dotenv');

const scriptDir = process.pkg ? dirname(process.execPath) : join(__dirname, '..');
const adjacentEnv = join(scriptDir, '.env');
dotenv.config({ path: existsSync(adjacentEnv) ? adjacentEnv : join(process.cwd(), '.env'), quiet: true });

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
const flags = new Set(process.argv.slice(3));

const showLinks = SOURCE_ISSUE_KEY === '--show-links' || flags.has('--show-links');
const supportedFlags = ['--copy-status', '--copy-comments', 'sameStatusTrue', '--show-links'];
const unknownFlags = [...flags].filter(flag => !supportedFlags.includes(flag));
if (!SOURCE_ISSUE_KEY || (SOURCE_ISSUE_KEY.startsWith('-') && SOURCE_ISSUE_KEY !== '--show-links') || unknownFlags.length) {
    if (unknownFlags.length) console.error(`Unknown option: ${unknownFlags.join(', ')}`);
    console.error("Usage: ./clone-master-win.exe <ISSUE_KEY> [--copy-status] [--copy-comments]");
    console.error("       ./clone-master-win.exe --show-links");
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
    SAME_STATUS: flags.has('--copy-status') || flags.has('sameStatusTrue'),
    COPY_COMMENTS: flags.has('--copy-comments'),
    SHOW_LINKS: showLinks,
    TARGETS: showLinks ? [] : loadTargets()
};