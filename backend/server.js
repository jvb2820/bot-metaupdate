require('dotenv').config();

const http = require('http');
const Anthropic = require('@anthropic-ai/sdk');

const PORT = Number(process.env.PORT || process.env.SERVER_PORT || 3001);
const CHAT_MODEL = process.env.ANTHROPIC_CHAT_MODEL || 'claude-haiku-4-5';
const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

function sendJson(response, statusCode, payload) {
    response.writeHead(statusCode, {
        'Access-Control-Allow-Origin': process.env.CORS_ORIGIN || 'http://127.0.0.1:5173',
        'Access-Control-Allow-Headers': 'Content-Type',
        'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
        'Content-Type': 'application/json'
    });
    response.end(JSON.stringify(payload));
}

function readJsonBody(request) {
    return new Promise((resolve, reject) => {
        let body = '';

        request.on('data', chunk => {
            body += chunk;

            if (body.length > 1_000_000) {
                request.destroy();
                reject(new Error('Request body is too large.'));
            }
        });

        request.on('end', () => {
            if (!body) {
                resolve({});
                return;
            }

            try {
                resolve(JSON.parse(body));
            } catch (error) {
                reject(new Error('Invalid JSON request body.'));
            }
        });

        request.on('error', reject);
    });
}

async function supabaseRequest(path, options = {}) {
    const restUrl = process.env.SUPABASE_REST_URL || (process.env.SUPABASE_URL ? `${process.env.SUPABASE_URL}/rest/v1` : '');
    const apiKey = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY;

    if (!restUrl || !apiKey) {
        throw new Error('Supabase configuration missing. Set SUPABASE_REST_URL and SUPABASE_ANON_KEY.');
    }

    const { default: fetch } = await import('node-fetch');
    const response = await fetch(`${restUrl.replace(/\/$/, '')}/${path}`, {
        method: options.method || 'GET',
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
        throw new Error(`Supabase request failed with ${response.status}: ${responseText}`);
    }

    return data;
}

async function listReports() {
    return supabaseRequest(
        'agent_reports?select=id,generated_at,period_label,period_start,period_end,has_shopify_data&order=generated_at.desc&limit=20'
    );
}

async function searchReportChunks(message, reportId) {
    const chunks = await supabaseRequest('rpc/search_agent_report_chunks', {
        method: 'POST',
        body: {
            query_text: message,
            match_count: 8
        }
    });

    if (!reportId || reportId === 'latest') {
        return chunks || [];
    }

    return (chunks || []).filter(chunk => chunk.report_id === reportId);
}

function buildContext(chunks) {
    if (!chunks.length) {
        return 'No matching report chunks were found.';
    }

    return chunks
        .map((chunk, index) => {
            return [
                `SOURCE ${index + 1}`,
                `Report period: ${chunk.period_label || 'Unknown'}`,
                `Section: ${chunk.heading || 'Report'}`,
                chunk.content
            ].join('\n');
        })
        .join('\n\n---\n\n');
}

async function answerQuestion(message, chunks) {
    const context = buildContext(chunks);

    const response = await client.messages.create({
        model: CHAT_MODEL,
        max_tokens: 900,
        temperature: 0.2,
        system: [
            'You are a performance marketing analyst answering questions from saved Teams reports.',
            'Use only the provided report context. If the context is insufficient, say what is missing and suggest the closest useful next step.',
            'Be concise, specific, and cite report sections by name when relevant.'
        ].join(' '),
        messages: [
            {
                role: 'user',
                content: [
                    {
                        type: 'text',
                        text: `REPORT CONTEXT\n${context}\n\nQUESTION\n${message}`
                    }
                ]
            }
        ]
    });

    return response.content
        .filter(block => block.type === 'text')
        .map(block => block.text)
        .join('\n')
        .trim();
}

function formatSources(chunks) {
    return chunks.map(chunk => ({
        id: chunk.id,
        reportId: chunk.report_id,
        title: chunk.heading || 'Report',
        period: chunk.period_label || 'Unknown period',
        excerpt: chunk.content.length > 280 ? `${chunk.content.slice(0, 277)}...` : chunk.content,
        rank: chunk.rank
    }));
}

async function handleChat(request, response) {
    const body = await readJsonBody(request);
    const message = String(body.message || '').trim();

    if (!message) {
        sendJson(response, 400, { error: 'Message is required.' });
        return;
    }

    const chunks = await searchReportChunks(message, body.reportId);
    const answer = chunks.length
        ? await answerQuestion(message, chunks)
        : 'I could not find matching report context yet. Once the scheduler stores reports in Supabase, I can answer from those saved Teams reports.';

    sendJson(response, 200, {
        answer,
        sources: formatSources(chunks)
    });
}

async function route(request, response) {
    const url = new URL(request.url, `http://${request.headers.host}`);

    if (request.method === 'OPTIONS') {
        sendJson(response, 204, {});
        return;
    }

    try {
        if (request.method === 'GET' && url.pathname === '/api/health') {
            sendJson(response, 200, { ok: true });
            return;
        }

        if (request.method === 'GET' && url.pathname === '/api/reports') {
            sendJson(response, 200, { reports: await listReports() });
            return;
        }

        if (request.method === 'POST' && url.pathname === '/api/chat') {
            await handleChat(request, response);
            return;
        }

        sendJson(response, 404, { error: 'Not found.' });
    } catch (error) {
        console.error(error);
        sendJson(response, 500, { error: error.message });
    }
}

http.createServer(route).listen(PORT, () => {
    console.log(`Chat API listening on http://127.0.0.1:${PORT}`);
});
