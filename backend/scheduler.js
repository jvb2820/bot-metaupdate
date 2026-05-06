require('dotenv').config();
const Anthropic = require('@anthropic-ai/sdk');

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

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
        return;
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
    } catch (error) {
        console.error('❌ Failed to send message to Teams:', error.message);
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
        console.log('✅ Meta Ads data fetched successfully.');

        const rawShopifyData = await fetchShopifyData();

        // 2. Build the prompt with all available data
        let dataPrompt = `Analyze the following data for the last 7 days and generate the full performance report as defined in your system prompt.\n\n`;
        dataPrompt += `## META ADS RAW DATA\n${rawMetaData}\n\n`;

        if (rawShopifyData) {
            dataPrompt += `## SHOPIFY DATA\n${rawShopifyData}\n\n`;
            dataPrompt += `## INSTRUCTIONS\nUse both Meta and Shopify data to complete ALL sections of the report: Top 5 Ads, Ad Pruning, Shopify Metrics, Cross-Platform Validation, Profitability, and Action Items.`;
        } else {
            dataPrompt += `## INSTRUCTIONS\nShopify data was unavailable. Complete the Meta Ads sections (Top 5 Ads, Ad Pruning) and note that Shopify sections could not be generated.`;
        }

        // 3. Analyze with Claude Agent
        const session = await client.beta.sessions.create({
            agent: process.env.AGENT_ID,
            environment_id: process.env.ENV_ID,
        }, { headers: { 'anthropic-beta': 'managed-agents-2026-04-01' } });

        await client.beta.sessions.events.send(session.id, {
            events: [{
                type: 'user.message',
                content: [{
                    type: 'text',
                    text: dataPrompt
                }]
            }]
        }, { headers: { 'anthropic-beta': 'managed-agents-2026-04-01' } });

        let reply = '';
        const stream = await client.beta.sessions.events.stream(session.id,
            { headers: { 'anthropic-beta': 'managed-agents-2026-04-01' } }
        );

        for await (const event of stream) {
            if (event.type === 'agent.message') {
                for (const block of event.content) {
                    if (block.type === 'text') reply += block.text;
                }
            }
            if (event.type === 'session.status_idle') break;
        }

        // 4. Post to Teams
        if (reply) {
            await sendToTeams(reply);
            console.log('✅ Report posted to Teams!');
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