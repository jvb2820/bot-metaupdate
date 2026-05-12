require('dotenv').config();
const Anthropic = require('@anthropic-ai/sdk');

const MANAGED_AGENTS_BETA = 'managed-agents-2026-04-01';
const ANTHROPIC_API_KEY = requireEnv('ANTHROPIC_API_KEY');
const AGENT_ID = requireEnv('AGENT_ID');
const ENV_ID = requireEnv('ENV_ID');

function requireEnv(name) {
    const value = process.env[name]?.trim();
    if (!value) {
        throw new Error(`Missing required environment variable: ${name}`);
    }
    return value;
}

const client = new Anthropic({ apiKey: ANTHROPIC_API_KEY });

/**
 * Retry wrapper with exponential backoff.
 * Retries up to `maxRetries` times, waiting longer each attempt.
 */
async function withRetry(fn, label, maxRetries = 3) {
    const delays = [60, 120, 240]; // seconds
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
        try {
            return await fn();
        } catch (error) {
            const isRateLimit =
                error.message?.includes('request limit reached') ||
                error.message?.includes('rate limit') ||
                error.message?.includes('too many');

            if (isRateLimit && attempt < maxRetries) {
                const waitSec = delays[attempt - 1];
                console.warn(`⏳ ${label}: Rate limited. Retrying in ${waitSec}s (attempt ${attempt}/${maxRetries})...`);
                await new Promise(r => setTimeout(r, waitSec * 1000));
            } else {
                throw error;
            }
        }
    }
}

/**
 * Fetches raw Meta Ads performance data from the Graph API.
 */
async function fetchMetaAdsData() {
    return withRetry(async () => {
        const accessToken = process.env.META_USER_TOKEN;
        let adAccountId = process.env.AD_ACCOUNT_ID;

        if (!accessToken || !adAccountId || adAccountId === 'your_ad_account_id') {
            throw new Error('Meta API credentials missing. Check META_USER_TOKEN and AD_ACCOUNT_ID in .env');
        }

        if (!adAccountId.startsWith('act_')) {
            adAccountId = 'act_' + adAccountId;
        }

        const { default: fetch } = await import('node-fetch');

        // Fields to fetch — includes funnel cost breakdowns and ROAS
        const fields = [
            'campaign_name',
            'adset_name',
            'ad_name',
            'spend',
            'impressions',
            'clicks',
            'actions',
            'cost_per_action_type',
            'action_values',
            'purchase_roas',
            'frequency',
            'cpm',
            'cpp',
            'ctr'
        ].join(',');

        const url = `https://graph.facebook.com/v19.0/${adAccountId}/insights?level=ad&fields=${fields}&date_preset=last_7d&access_token=${accessToken}`;

        console.log('Fetching Meta Ads data...');
        const response = await fetch(url);
        const result = await response.json();

        if (result.error) {
            throw new Error(`Meta API Error: ${result.error.message}`);
        }

        return JSON.stringify(result.data, null, 2);
    }, 'Meta Ads API');
}

/**
 * Generates a fresh Shopify access token using OAuth client_credentials grant.
 * Token expires every ~24 hours, so we generate a new one each run.
 */
async function getShopifyAccessToken() {
    const storeUrl = process.env.SHOPIFY_STORE_URL;
    const clientId = process.env.SHOPIFY_CLIENT_ID;
    const clientSecret = process.env.SHOPIFY_CLIENT_SECRET;

    if (!storeUrl || !clientId || !clientSecret) {
        return null;
    }

    const { default: fetch } = await import('node-fetch');

    const tokenUrl = `https://${storeUrl}.myshopify.com/admin/oauth/access_token`;

    const response = await fetch(tokenUrl, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
            'Accept': 'application/json'
        },
        body: new URLSearchParams({
            grant_type: 'client_credentials',
            client_id: clientId,
            client_secret: clientSecret
        })
    });

    if (!response.ok) {
        throw new Error(`Shopify OAuth failed with ${response.status}: ${await response.text()}`);
    }

    const data = await response.json();
    console.log(`✅ Shopify access token generated (expires in ${data.expires_in}s)`);
    return data.access_token;
}

/**
 * Fetches Shopify order and sales data from the Admin API (last 7 days).
 */
async function fetchShopifyData() {
    const storeUrl = process.env.SHOPIFY_STORE_URL;

    if (!storeUrl || !process.env.SHOPIFY_CLIENT_ID || !process.env.SHOPIFY_CLIENT_SECRET) {
        console.warn('⚠️ Skipping Shopify data: SHOPIFY_STORE_URL, SHOPIFY_CLIENT_ID, or SHOPIFY_CLIENT_SECRET not configured.');
        return null;
    }

    // Generate a fresh access token
    const accessToken = await getShopifyAccessToken();

    const { default: fetch } = await import('node-fetch');

    // Calculate date 7 days ago
    const sevenDaysAgo = new Date();
    sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);
    const sinceDate = sevenDaysAgo.toISOString();

    const baseUrl = `https://${storeUrl}.myshopify.com/admin/api/2024-01`;

    console.log('Fetching Shopify data...');

    try {
        // Fetch orders from the last 7 days
        const ordersUrl = `${baseUrl}/orders.json?status=any&created_at_min=${sinceDate}&limit=250`;
        const ordersResponse = await fetch(ordersUrl, {
            headers: {
                'X-Shopify-Access-Token': accessToken,
                'Content-Type': 'application/json'
            }
        });

        if (!ordersResponse.ok) {
            throw new Error(`Shopify API responded with ${ordersResponse.status}: ${await ordersResponse.text()}`);
        }

        const ordersData = await ordersResponse.json();
        const orders = ordersData.orders || [];

        // Compute summary metrics
        const totalOrders = orders.length;
        const totalRevenue = orders.reduce((sum, o) => sum + parseFloat(o.total_price || 0), 0);
        const avgOrderValue = totalOrders > 0 ? (totalRevenue / totalOrders).toFixed(2) : 0;

        // Traffic source breakdown from referring_site and source_name
        const trafficSources = {};
        orders.forEach(order => {
            const source = order.source_name || 'unknown';
            const referrer = order.referring_site || '';
            let channel = 'Direct';

            if (referrer.includes('google')) channel = 'Google';
            else if (referrer.includes('facebook') || referrer.includes('fb') || referrer.includes('instagram') || referrer.includes('meta')) channel = 'Meta';
            else if (referrer.includes('tiktok')) channel = 'TikTok';
            else if (referrer.includes('klaviyo')) channel = 'Klaviyo';
            else if (source === 'web' && !referrer) channel = 'Direct';
            else if (referrer) channel = referrer;

            trafficSources[channel] = (trafficSources[channel] || 0) + 1;
        });

        // Revenue by channel
        const revenueBySources = {};
        orders.forEach(order => {
            const referrer = order.referring_site || '';
            let channel = 'Direct';

            if (referrer.includes('google')) channel = 'Google';
            else if (referrer.includes('facebook') || referrer.includes('fb') || referrer.includes('instagram') || referrer.includes('meta')) channel = 'Meta';
            else if (referrer.includes('tiktok')) channel = 'TikTok';
            else if (referrer.includes('klaviyo')) channel = 'Klaviyo';
            else if (referrer) channel = referrer;

            revenueBySources[channel] = (revenueBySources[channel] || 0) + parseFloat(order.total_price || 0);
        });

        const shopifySummary = {
            period: `Last 7 days (since ${sevenDaysAgo.toISOString().split('T')[0]})`,
            total_orders: totalOrders,
            total_revenue: totalRevenue.toFixed(2),
            average_order_value: avgOrderValue,
            orders_by_traffic_source: trafficSources,
            revenue_by_traffic_source: revenueBySources,
            currency: orders[0]?.currency || 'USD'
        };

        console.log('✅ Shopify data fetched successfully.');
        return JSON.stringify(shopifySummary, null, 2);

    } catch (error) {
        console.error('❌ Shopify fetch error:', error.message);
        return null;
    }
}

/**
 * Sends a message to Microsoft Teams via an Incoming Webhook.
 */
async function sendToTeams(message) {
    const webhookUrl = process.env.TEAMS_WEBHOOK_URL;
    
    if (!webhookUrl || webhookUrl === 'your_teams_webhook_url') {
        console.warn('⚠️ Skipping Teams notification: TEAMS_WEBHOOK_URL is not configured.');
        return false;
    }

    try {
        const { default: fetch } = await import('node-fetch');
        const response = await fetch(webhookUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                text: `**Daily Meta Ads & Shopify Performance Report**\n\n${message}`
            })
        });

        if (!response.ok) {
            throw new Error(`Teams API responded with ${response.status}: ${await response.text()}`);
        }

        return true;
    } catch (error) {
        console.error('❌ Failed to send message to Teams:', error.message);
        return false;
    }
}

function parseJsonOrNull(value) {
    if (!value) {
        return null;
    }

    try {
        return JSON.parse(value);
    } catch (error) {
        console.warn('Could not parse JSON payload for storage:', error.message);
        return null;
    }
}

function getReportPeriod() {
    const periodEnd = new Date();
    const periodStart = new Date(periodEnd);
    periodStart.setDate(periodStart.getDate() - 7);

    return {
        periodStart: periodStart.toISOString().split('T')[0],
        periodEnd: periodEnd.toISOString().split('T')[0],
        periodLabel: `Last 7 days (${periodStart.toISOString().split('T')[0]} to ${periodEnd.toISOString().split('T')[0]})`
    };
}

function chunkReport(reportText) {
    const sections = reportText
        .split(/\n(?=#{1,4}\s+)/g)
        .map(section => section.trim())
        .filter(Boolean);

    const sourceSections = sections.length > 1 ? sections : [reportText.trim()];
    const chunks = [];

    for (const section of sourceSections) {
        const headingMatch = section.match(/^#{1,4}\s+(.+)$/m);
        const heading = headingMatch ? headingMatch[1].trim() : 'Report';

        for (let start = 0; start < section.length; start += 3000) {
            const content = section.slice(start, start + 3000).trim();
            if (!content) {
                continue;
            }

            chunks.push({
                chunk_index: chunks.length,
                heading,
                content,
                token_estimate: Math.ceil(content.length / 4)
            });
        }
    }

    return chunks;
}

function isCompleteReport(reportText) {
    if (!reportText) {
        return false;
    }

    const requiredSections = [
        'Executive Summary',
        'Top 5 Ads',
        'Ad Pruning',
        'Shopify Metrics',
        'Cross-Platform Validation',
        'Profitability',
        'Action Items'
    ];

    return requiredSections.every(section => reportText.toLowerCase().includes(section.toLowerCase()));
}

function isRetriableAgentError(error) {
    const status = error?.status;
    if ([400, 401, 403, 404].includes(status)) {
        return false;
    }

    const message = error?.message || '';
    if (message.includes('requires user/tool action') || message.includes('incomplete report')) {
        return false;
    }

    return true;
}

async function supabaseRequest(table, options = {}) {
    const restUrl = process.env.SUPABASE_REST_URL || (process.env.SUPABASE_URL ? `${process.env.SUPABASE_URL}/rest/v1` : '');
    const apiKey = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY;

    if (!restUrl || !apiKey) {
        throw new Error('Supabase configuration missing. Set SUPABASE_REST_URL and SUPABASE_ANON_KEY.');
    }

    const { default: fetch } = await import('node-fetch');
    const response = await fetch(`${restUrl.replace(/\/$/, '')}/${table}${options.query || ''}`, {
        method: options.method || 'POST',
        headers: {
            apikey: apiKey,
            Authorization: `Bearer ${apiKey}`,
            'Content-Type': 'application/json',
            Prefer: 'return=representation'
        },
        body: options.body ? JSON.stringify(options.body) : undefined
    });

    const responseText = await response.text();
    const data = responseText ? JSON.parse(responseText) : null;

    if (!response.ok) {
        throw new Error(`Supabase ${table} request failed with ${response.status}: ${responseText}`);
    }

    return data;
}

async function storeReportInSupabase({ reportText, rawMetaData, rawShopifyData, dataPrompt, sessionId }) {
    try {
        const { periodStart, periodEnd, periodLabel } = getReportPeriod();
        const metaRaw = parseJsonOrNull(rawMetaData);
        const shopifySummary = parseJsonOrNull(rawShopifyData);

        const reportRows = await supabaseRequest('agent_reports', {
            body: {
                generated_at: new Date().toISOString(),
                period_start: periodStart,
                period_end: periodEnd,
                period_label: periodLabel,
                report_text: reportText,
                prompt_text: dataPrompt,
                meta_raw: metaRaw,
                shopify_summary: shopifySummary,
                has_shopify_data: Boolean(shopifySummary),
                agent_session_id: sessionId
            }
        });

        const reportId = reportRows?.[0]?.id;
        if (!reportId) {
            throw new Error('Supabase did not return the inserted report id.');
        }

        const chunks = chunkReport(reportText).map(chunk => ({
            report_id: reportId,
            ...chunk,
            metadata: {
                period_start: periodStart,
                period_end: periodEnd,
                period_label: periodLabel
            }
        }));

        if (chunks.length > 0) {
            await supabaseRequest('agent_report_chunks', { body: chunks });
        }

        console.log(`Report stored in Supabase (${reportId}, ${chunks.length} chunks).`);
        return reportId;
    } catch (error) {
        console.error('Failed to store report in Supabase:', error.message);
        return null;
    }
}

/**
 * Main function to run the data fetch, agent analysis, and post the results.
 */
async function runWorkflow() {
    console.log(`[${new Date().toLocaleString()}] Starting automation workflow...`);

    try {
        // 1. Fetch Raw Data from both sources
        const rawMetaData = await fetchMetaAdsData();
        console.log(`✅ Meta Ads data fetched successfully (${(Buffer.byteLength(rawMetaData) / 1024).toFixed(2)} KB).`);

        const rawShopifyData = await fetchShopifyData();
        if (rawShopifyData) {
            console.log(`✅ Shopify data fetched successfully (${(Buffer.byteLength(rawShopifyData) / 1024).toFixed(2)} KB).`);
        }

        // 2. Build the prompt with all available data
        let dataPrompt = [
            'Analyze the following data for the last 7 days and generate the full performance report as defined in your system prompt.',
            'This is an unattended scheduled workflow. Do not ask follow-up questions and do not narrate your process.',
            'Use these benchmarks unless the data explicitly provides different ones: target ROAS >= 2.0, target CTR >= 1%, target CPA should be evaluated against 50% COGS/product-margin assumptions.',
            'Return only the final report with these sections: Executive Summary, Top 5 Ads Table, Ad Pruning List, Shopify Metrics, Cross-Platform Validation, Profitability Calculation, Action Items.',
            ''
        ].join('\n');
        dataPrompt += `## META ADS RAW DATA\n${rawMetaData}\n\n`;

        if (rawShopifyData) {
            dataPrompt += `## SHOPIFY DATA\n${rawShopifyData}\n\n`;
            dataPrompt += `## INSTRUCTIONS\nUse both Meta and Shopify data to complete ALL sections of the report: Top 5 Ads, Ad Pruning, Shopify Metrics, Cross-Platform Validation, Profitability, and Action Items.`;
        } else {
            dataPrompt += `## INSTRUCTIONS\nShopify data was unavailable. Complete the Meta Ads sections (Top 5 Ads, Ad Pruning) and note that Shopify sections could not be generated.`;
        }

        // 3. Analyze with Claude Agent (with retry for transient failures)
        const MAX_AGENT_RETRIES = 2;
        const AGENT_TIMEOUT_MS = 5 * 60 * 1000; // 5-minute timeout per attempt
        let reply = '';
        let sessionId = null;

        for (let agentAttempt = 1; agentAttempt <= MAX_AGENT_RETRIES; agentAttempt++) {
            try {
                reply = '';
                const session = await client.beta.sessions.create({
                    agent: AGENT_ID,
                    environment_id: ENV_ID,
                }, { headers: { 'anthropic-beta': MANAGED_AGENTS_BETA } });
                sessionId = session.id;

                console.log(`🚀 Starting Anthropic session (${session.id}) — attempt ${agentAttempt}/${MAX_AGENT_RETRIES}...`);

                await client.beta.sessions.events.send(session.id, {
                    events: [{
                        type: 'user.message',
                        content: [{
                            type: 'text',
                            text: dataPrompt
                        }]
                    }]
                }, { headers: { 'anthropic-beta': MANAGED_AGENTS_BETA } });

                console.log('📡 Streaming events from agent...');

                const stream = await client.beta.sessions.events.stream(session.id,
                    { headers: { 'anthropic-beta': MANAGED_AGENTS_BETA } }
                );

                // Race the stream against a timeout
                let timedOut = false;
                const timeout = setTimeout(() => { timedOut = true; }, AGENT_TIMEOUT_MS);

                for await (const event of stream) {
                    if (timedOut) {
                        console.error('\n⏰ Agent session timed out after 5 minutes.');
                        break;
                    }

                    console.log(`🔹 Event received: ${event.type}`);

                    if (event.type === 'agent.message') {
                        for (const block of event.content) {
                            if (block.type === 'text') {
                                reply += block.text;
                                process.stdout.write('.');
                            }
                        }
                    }

                    if (event.type === 'error' || event.type === 'exception') {
                        console.error(`\n❌ Agent Stream Error:`, JSON.stringify(event, null, 2));
                    }

                    if (event.type === 'session.status_idle') {
                        const stopReason = event.stop_reason?.type || 'unknown';
                        console.log(`\n✅ Session reached idle state (${stopReason}).`);
                        if (stopReason === 'requires_action') {
                            const eventIds = event.stop_reason.event_ids?.join(', ') || 'unknown';
                            throw new Error(`Agent requires user/tool action before it can finish. Pending event ids: ${eventIds}`);
                        }
                        if (stopReason === 'retries_exhausted') {
                            throw new Error('Agent retries exhausted before producing a complete report.');
                        }
                        break;
                    }
                }

                clearTimeout(timeout);

                // If we got a complete report, break out of the retry loop
                if (isCompleteReport(reply)) break;

                // If timed out or empty reply, treat as retriable
                if (timedOut) throw new Error('Agent session timed out');
                if (!reply) throw new Error('Agent returned empty response');
                throw new Error('Agent returned an incomplete report and it will not be posted.');

            } catch (agentError) {
                console.error(`\n❌ Agent attempt ${agentAttempt} failed:`, agentError.message);
                console.error('   Full error:', JSON.stringify(agentError, Object.getOwnPropertyNames(agentError), 2));
                if (agentAttempt < MAX_AGENT_RETRIES && isRetriableAgentError(agentError)) {
                    console.log(`⏳ Retrying in 30s...`);
                    await new Promise(r => setTimeout(r, 30000));
                } else {
                    throw agentError; // Final attempt — let the outer catch handle it
                }
            }
        }

        // 4. Store the report for RAG, then post to Teams
        if (reply) {
            await storeReportInSupabase({
                reportText: reply,
                rawMetaData,
                rawShopifyData,
                dataPrompt,
                sessionId
            });

            const teamsPosted = await sendToTeams(reply);
            if (teamsPosted) {
                console.log('✅ Report posted to Teams!');
            }
        } else {
            console.warn('⚠️ Agent returned an empty response.');
        }

    } catch (error) {
        console.error('❌ Workflow Error:', error.message);
        process.exit(1); // Exit with error for GitHub Actions
    }
}

// Execute the workflow
runWorkflow();
