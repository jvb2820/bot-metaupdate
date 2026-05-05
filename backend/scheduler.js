require('dotenv').config();
const Anthropic = require('@anthropic-ai/sdk');

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

/**
 * Fetches raw Meta Ads performance data from the Graph API.
 */
async function fetchMetaAdsData() {
    const accessToken = process.env.META_USER_TOKEN;
    const adAccountId = process.env.AD_ACCOUNT_ID;

    if (!accessToken || !adAccountId || adAccountId === 'your_ad_account_id') {
        throw new Error('Meta API credentials missing. Check META_USER_TOKEN and AD_ACCOUNT_ID in .env');
    }

    const { default: fetch } = await import('node-fetch');
    
    // Fields to fetch for analysis
    const fields = [
        'campaign_name',
        'adset_name',
        'ad_name',
        'spend',
        'impressions',
        'clicks',
        'actions', // for conversions/ROAS
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
                text: `**Daily Meta Ads Performance Report**\n\n${message}`
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
        // 1. Fetch Raw Data
        const rawData = await fetchMetaAdsData();
        console.log('✅ Meta Ads data fetched successfully.');

        // 2. Analyze with Claude
        const session = await client.beta.sessions.create({
            agent: process.env.AGENT_ID,
            environment_id: process.env.ENV_ID,
        }, { headers: { 'anthropic-beta': 'managed-agents-2026-04-01' } });

        await client.beta.sessions.events.send(session.id, {
            events: [{
                type: 'user.message',
                content: [{
                    type: 'text',
                    text: `Analyze the following Meta Ads raw data for the last 7 days and generate the performance report. Use the targets (ROAS/CPA) defined in your system prompt or use industry defaults if none provided.\n\nRAW DATA:\n${rawData}`
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

        // 3. Post to Teams
        if (reply) {
            await sendToTeams(reply);
            console.log('✅ Update posted to Teams!');
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