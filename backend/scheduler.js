const Anthropic = require('@anthropic-ai/sdk');

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

async function sendToTeams(message) {
    const { default: fetch } = await import('node-fetch');
    await fetch(process.env.TEAMS_WEBHOOK_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: message })
    });
}

async function runAgentAndPost() {
    console.log('Starting agent session...');

    const session = await client.beta.sessions.create({
        agent: process.env.AGENT_ID,
        environment_id: process.env.ENV_ID,
    }, { headers: { 'anthropic-beta': 'managed-agents-2026-04-01' } });

    await client.beta.sessions.events.send(session.id, {
        events: [{
            type: 'user.message',
            content: [{
                type: 'text',
                text: 'Generate a daily Meta Ads performance summary. Highlight top performing campaigns, any creative fatigue alerts, and budget recommendations for today.'
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

    await sendToTeams(reply);
    console.log('✅ Update posted to Teams!');
}

runAgentAndPost().catch(console.error);