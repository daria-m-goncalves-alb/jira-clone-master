// ==========================================
// General Helpers & Utilities
// ==========================================

function transformSummaryForTarget(target, originalSummary) {
    if (!target || !originalSummary) return originalSummary;

    // if stripBrackets flag is set, remove all [...], including surrounding spaces
    if (target.stripBrackets) {
        return originalSummary.replace(/\s*\[[^\]]*\]/g, '').trim();
    }

    // remove only the first leading [...] group
    const summaryWithoutFirstGroup = originalSummary.replace(/^\s*\[[^\]]*\]\s*/, '');

    // determine client prefix (support string or array)
    const clientPrefix = Array.isArray(target.client)
        ? target.client.map(c => `[${c}]`).join(' ')
        : target.client ? `[${target.client}]` : null;

    // if client present, prefix with it; otherwise just return the summary without first group
    if (clientPrefix) {
        return `${clientPrefix} ${summaryWithoutFirstGroup}`.trim();
    }

    return summaryWithoutFirstGroup;
}

// Add a delay between operations
function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

module.exports = {
    transformSummaryForTarget,
    sleep
};