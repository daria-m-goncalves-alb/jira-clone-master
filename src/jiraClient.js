const axios = require('axios');
const { JIRA_BASE, API_USER, API_TOKEN } = require('./config');

const headers = {
    "Content-Type": "application/json",
    Authorization: "Basic " + Buffer.from(`${API_USER}:${API_TOKEN}`).toString("base64"),
};

async function jiraGet(path) {
    const response = await axios.get(`${JIRA_BASE}${path}`, { headers });
    return response.data;
}

async function jiraPost(path, body, extraHeaders = {}) {
    const response = await axios.post(`${JIRA_BASE}${path}`, body, {
        headers: { ...headers, ...extraHeaders }
    });
    return response.data || {};
}

module.exports = { headers, jiraGet, jiraPost, JIRA_BASE };