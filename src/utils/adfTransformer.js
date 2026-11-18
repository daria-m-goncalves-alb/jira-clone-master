// ==========================================
// Atlassian Document Format (ADF) Processing
// ==========================================

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

        // Rewrite media node IDs — drop if not remapped (stale ID causes ATTACHMENT_VALIDATION_ERROR)
        if (node.type === "media" && node.attrs?.id) {
            if (idMap.has(node.attrs.id)) {
                return {
                    ...node,
                    attrs: {
                        ...node.attrs,
                        id: idMap.get(node.attrs.id),
                        collection: "jira-issue"
                    }
                };
            } else {
                return null; // Can't remap → drop; normalizeADF will remove the empty mediaSingle
            }
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

module.exports = {
    extractMediaIds,
    normalizeADF,
    rewriteMediaIds,
    finalJiraADF,
    forceBlockADF,
    sanitizeADF
};