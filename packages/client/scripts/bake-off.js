#!/usr/bin/env node
/**
 * Model bake-off — speed-first benchmark.
 * 
 * Sends the same prompt to each model, measures time-to-first-token
 * and total duration. Appends results to logs/model-evals.jsonl.
 *
 * Usage: node scripts/bake-off.js
 */

const https = require('https');
const http = require('http');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

// ─── Config ────────────────────────────────────────────────────────────────
const OLLAMA_API_KEY = process.env.OLLAMA_API_KEY || '';
const OLLAMA_BASE = 'https://ollama.com/v1';
const LOG_FILE = path.resolve(__dirname, '..', 'logs', 'bake-off.csv');

const MODELS_TO_TEST = [
  // Fast tier
  'gemma3:12b',
  'gemma3:4b', 
  'deepseek-v4-flash',
  // Mid tier
  'gemma3:27b',
  'qwen3-next:80b',
  'kimi-k2.6',
  'glm-5',
  'glm-4.7',
  // Heavy tier
  'gemma4:31b',
  'deepseek-v4-pro',
  'gpt-oss:20b',
  'gpt-oss:120b',
];

const TEST_PROMPT = 'show me the first 5 moodle courses';

// ─── Helpers ────────────────────────────────────────────────────────────────

function apiRequest(model, signal) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({
      model,
      messages: [
        {
          role: 'system',
          content: 'You are a concise Moodle data analyst. Be brief.',
        },
        { role: 'user', content: TEST_PROMPT },
      ],
      stream: true,
      max_tokens: 300,
    });

    const url = new URL(OLLAMA_BASE + '/chat/completions');
    const agent = url.protocol === 'https:' ? https : http;

    const req = agent.request(
      url,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${OLLAMA_API_KEY}`,
        },
        signal,
      },
      (res) => {
        if (res.statusCode !== 200) {
          let errBody = '';
          res.on('data', (c) => (errBody += c));
          res.on('end', () => {
            reject(new Error(`HTTP ${res.statusCode}: ${errBody.slice(0, 200)}`));
          });
          return;
        }

        let buffer = '';
        let firstToken = false;
        let ttftMs = null;
        const startTime = Date.now();

        res.on('data', (chunk) => {
          if (!firstToken) {
            ttftMs = Date.now() - startTime;
            firstToken = true;
          }
          buffer += chunk.toString();
        });

        res.on('end', () => {
          const totalMs = Date.now() - startTime;
          // Extract content from stream
          const lines = buffer.split('\n').filter((l) => l.startsWith('data: '));
          let content = '';
          for (const line of lines) {
            try {
              const j = JSON.parse(line.slice(6));
              const delta = j.choices?.[0]?.delta?.content;
              if (delta) content += delta;
            } catch {}
          }

          resolve({
            model,
            ttftMs: ttftMs || 0,
            totalMs,
            contentLength: content.length,
            firstWords: content.slice(0, 80).replace(/\n/g, ' '),
          });
        });

        res.on('error', reject);
      }
    );

    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

// ─── Main ───────────────────────────────────────────────────────────────────

async function main() {
  console.log('🔬 Model Bake-off: Speed Test');
  console.log(`Prompt: "${TEST_PROMPT}"`);
  console.log(`Models: ${MODELS_TO_TEST.length}`);
  console.log('─'.repeat(70));
  console.log(
    'Model'.padEnd(24) +
      'TTFT'.padStart(8) +
      'Total'.padStart(8) +
      'Chars'.padStart(7) +
      '  First words'
  );

  const results = [];

  for (const model of MODELS_TO_TEST) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 30000);

    try {
      process.stdout.write(`${model.padEnd(24)}`);
      const r = await apiRequest(model, controller.signal);
      clearTimeout(timeout);

      console.log(
        `${String(r.ttftMs + 'ms').padStart(8)}` +
          `${String(r.totalMs + 'ms').padStart(8)}` +
          `${String(r.contentLength).padStart(7)}  ` +
          ` ${r.firstWords}`
      );

      results.push(r);
    } catch (e) {
      clearTimeout(timeout);
      console.log(`${'ERR'.padStart(8)}  ${e.message.slice(0, 60)}`);
      results.push({ model, error: e.message });
    }
  }

  // ─── Write CSV ──────────────────────────────────────────────────────────
  const csvHeader = 'timestamp,model,ttft_ms,total_ms,content_chars,error\n';
  const now = new Date().toISOString();
  const rows = results.map((r) =>
    [now, r.model, r.ttftMs || '', r.totalMs || '', r.contentLength || '', r.error || ''].join(',')
  );

  fs.mkdirSync(path.dirname(LOG_FILE), { recursive: true });
  const exists = fs.existsSync(LOG_FILE);
  fs.appendFileSync(LOG_FILE, (exists ? '' : csvHeader) + rows.join('\n') + '\n');

  // ─── Summary ─────────────────────────────────────────────────────────────
  console.log('\n📊 Top 5 by speed (TTFT):');
  const ranked = results
    .filter((r) => r.ttftMs)
    .sort((a, b) => a.ttftMs - b.ttftMs)
    .slice(0, 5);
  ranked.forEach((r, i) => {
    console.log(`  ${i + 1}. ${r.model} — ${r.ttftMs}ms TTFT / ${r.totalMs}ms total`);
  });

  const avgTtft = Math.round(
    results.filter((r) => r.ttftMs).reduce((s, r) => s + r.ttftMs, 0) /
      results.filter((r) => r.ttftMs).length
  );
  console.log(`\n✅ Average TTFT: ${avgTtft}ms | Results: ${LOG_FILE}`);
}

main().catch((e) => {
  console.error('Bake-off failed:', e.message);
  process.exit(1);
});
