// ==========================================
// Attachment and Media Handling
// ==========================================

const axios = require("axios");
const FormData = require("form-data");
const AdmZip = require("adm-zip");
const { JIRA_BASE, headers } = require("../jiraClient");

// Resolve the Atlassian Media UUID for an attachment by following the content URL redirect.
// Jira Cloud redirects /rest/api/3/attachment/content/{id} → https://api.media.atlassian.com/file/{UUID}/...
async function getMediaUUID(contentUrl) {
    try {
        const res = await axios.get(contentUrl, {
            headers,
            maxRedirects: 0,
            validateStatus: () => true
        });
        const location = res.headers?.location || '';
        const match = location.match(/\/file\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i);
        return match ? match[1] : null;
    } catch {
        return null;
    }
}

async function downloadImageAttachments(srcIssue, mediaIds) {
    const images = new Map();
    const embeddedAttachmentIds = new Set(); // numeric att.id values resolved to ADF media nodes

    const attachments = srcIssue.fields.attachment || [];
    for (const att of attachments) {
        // Resolve the real media UUID via redirect; fall back to numeric REST ID
        const mediaUUID = await getMediaUUID(att.content);
        const effectiveId = mediaUUID || att.id;

        if (!mediaIds.includes(effectiveId)) continue;

        const res = await axios.get(att.content, {
            headers,
            responseType: "arraybuffer"
        });

        images.set(effectiveId, {
            filename: att.filename,
            buffer: Buffer.from(res.data),
            mimeType: att.mimeType
        });
        embeddedAttachmentIds.add(att.id);
    }

    return { images, embeddedAttachmentIds };
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
            // Try to resolve the new media UUID; fall back to numeric REST ID
            const newMediaUUID = await getMediaUUID(newAttachment.content);
            idMap.set(oldId, newMediaUUID || newAttachment.id);
        }
    }

    return idMap;
}

// Upload attachments that were not already uploaded while cloning the description.
async function cloneRemainingAttachments(srcIssue, newIssueKey, embeddedAttachmentIds) {
    const attachments = srcIssue.fields.attachment || [];

    for (const att of attachments) {
        if (embeddedAttachmentIds.has(att.id)) continue;

        // Download the attachment from Jira
        const response = await axios.get(att.content, {
            headers,
            responseType: 'arraybuffer'
        });
        const buffer = Buffer.from(response.data);

        let uploadBuffer = buffer;
        let uploadName = att.filename;

        // Zip unsupported file types
        const unsupported = [".msg",".eml",".exe",".dll",".bat",".cmd",".sh",".ini",".sys",".db"];
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
        } catch (err) {
            console.error(`❌ Failed to upload ${uploadName}:`, err.response?.data || err.message);
        }
    }
}

module.exports = {
    getMediaUUID,
    downloadImageAttachments,
    uploadImages,
    cloneRemainingAttachments
};