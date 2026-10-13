/**
 * ============================================================
 * data_enricher.js — Lead Generation Pipeline Utility
 * ============================================================
 *
 * Standalone Node.js module demonstrating the core algorithmic
 * logic of the n8n Lead Generation workflow.
 *
 * Features:
 *   - Regex-based email & domain validation
 *   - Multi-dimensional lead scoring engine
 *   - Deduplication (by email + by domain)
 *   - Domain-isolated routing (AI/ML vs Financial)
 *   - State machine lifecycle management
 *
 * Usage:
 *   node scripts/data_enricher.js
 *   node scripts/data_enricher.js --input ./path/to/leads.json
 *
 * Dependencies: None (pure Node.js stdlib)
 * Node.js >= 16.x required
 * ============================================================
 */

'use strict';

// ─── Constants ────────────────────────────────────────────────────────────────

/**
 * RFC 5322–compliant email regex (simplified, production-safe).
 * Matches: local@domain.tld, sub.local+tag@sub.domain.co.uk
 */
const EMAIL_REGEX =
  /^[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}$/;

/**
 * Domain format validator — rejects IP addresses and bare hostnames.
 */
const DOMAIN_REGEX = /^[a-zA-Z0-9\-]+(\.[a-zA-Z0-9\-]+)*\.[a-zA-Z]{2,}$/;

/**
 * Known throwaway / spam email domain blocklist.
 */
const BLOCKLIST_DOMAINS = new Set([
  'spam.biz', 'test.com', 'example.com', 'mailinator.com',
  'guerrillamail.com', 'throwam.com', 'yopmail.com',
  'trashmail.com', 'sharklasers.com', 'dispostable.com'
]);

/**
 * Industries classified as AI/ML-adjacent.
 */
const AI_INDUSTRIES = new Set([
  'artificial intelligence', 'machine learning', 'data science',
  'healthtech', 'edtech', 'robotics', 'autonomous systems',
  'computer vision', 'nlp', 'deep learning', 'mlops',
  'bioinformatics', 'agritech'
]);

/**
 * Industries classified as Financial/FinTech-adjacent.
 */
const FINTECH_INDUSTRIES = new Set([
  'financial services', 'fintech', 'banking', 'insurance',
  'wealth management', 'payments', 'cryptocurrency', 'capital markets',
  'asset management', 'lending', 'compliance', 'regtech',
  'insurtech', 'neobank', 'trading'
]);

/**
 * Qualification score thresholds per domain.
 */
const SCORE_THRESHOLDS = {
  AI_ML:     60,
  FINANCIAL: 70,
  GENERAL:   55
};

/**
 * Pipeline lifecycle states (ordered).
 */
const STATES = Object.freeze({
  NEW:                    'NEW',
  VALIDATED:              'VALIDATED',
  SCORED:                 'SCORED',
  QUALIFIED_AI_LEAD:      'QUALIFIED_AI_LEAD',
  QUALIFIED_FINANCIAL:    'QUALIFIED_FINANCIAL_LEAD',
  DISQUALIFIED:           'DISQUALIFIED'
});

// ─── Validation Layer ─────────────────────────────────────────────────────────

/**
 * Validates a single lead's syntax and structural integrity.
 *
 * @param {Object} lead - Raw lead object
 * @returns {{ valid: boolean, reasons: string[] }}
 */
function validateLead(lead) {
  const reasons = [];

  // Email syntax check
  if (!lead.email || typeof lead.email !== 'string') {
    reasons.push('MISSING_EMAIL');
  } else if (!EMAIL_REGEX.test(lead.email.trim())) {
    reasons.push('INVALID_EMAIL_SYNTAX');
  }

  // Name check
  if (!lead.name || lead.name.trim().length < 2) {
    reasons.push('MISSING_NAME');
  }

  // Company check
  if (!lead.company || lead.company.trim().length < 2) {
    reasons.push('MISSING_COMPANY');
  }

  // Domain validation
  const domain = (lead.domain || '').toLowerCase().trim();
  if (!domain) {
    reasons.push('MISSING_DOMAIN');
  } else if (!DOMAIN_REGEX.test(domain)) {
    reasons.push('INVALID_DOMAIN_FORMAT');
  } else if (BLOCKLIST_DOMAINS.has(domain)) {
    reasons.push('BLOCKED_DOMAIN');
  }

  // Revenue floor ($1M minimum)
  if (!lead.annual_revenue || lead.annual_revenue < 1_000_000) {
    reasons.push('REVENUE_BELOW_THRESHOLD');
  }

  return {
    valid: reasons.length === 0,
    reasons
  };
}

// ─── Deduplication Engine ─────────────────────────────────────────────────────

/**
 * Removes duplicate leads from an array.
 * Deduplicates by:
 *   1. Exact email match (case-insensitive)
 *   2. Domain + company name match (catches subsidiary duplicates)
 *
 * @param {Object[]} leads - Array of raw lead objects
 * @returns {{ unique: Object[], duplicates: Object[] }}
 */
function deduplicateLeads(leads) {
  const emailSeen   = new Map();  // email -> first lead
  const domainSeen  = new Map();  // domain:company -> first lead
  const unique      = [];
  const duplicates  = [];

  for (const lead of leads) {
    const emailKey  = (lead.email  || '').toLowerCase().trim();
    const company   = (lead.company || '').toLowerCase().trim().replace(/\s+/g, '-');
    const domain    = (lead.domain  || '').toLowerCase().trim();
    const domainKey = `${domain}::${company}`;

    let dupOf = null;

    if (emailKey && emailSeen.has(emailKey)) {
      dupOf = `EMAIL_DUP_OF_${emailSeen.get(emailKey)}`;
    } else if (domainKey !== '::' && domainSeen.has(domainKey)) {
      dupOf = `DOMAIN_COMPANY_DUP_OF_${domainSeen.get(domainKey)}`;
    }

    if (dupOf) {
      lead._duplicate_of = dupOf;
      duplicates.push(lead);
    } else {
      if (emailKey)  emailSeen.set(emailKey, lead.id || emailKey);
      if (domainKey !== '::') domainSeen.set(domainKey, lead.id || domainKey);
      unique.push(lead);
    }
  }

  return { unique, duplicates };
}

// ─── Scoring Engine ───────────────────────────────────────────────────────────

/**
 * Computes a multi-dimensional score for a validated lead.
 *
 * Scoring Dimensions:
 *   - Revenue       : 0–30 pts
 *   - Headcount     : 0–15 pts
 *   - Seniority     : 0–15 pts
 *   - AI Domain     : 0–85 pts (conditional)
 *   - Financial Dom : 0–95 pts (conditional)
 *   - Source Quality: 0–10 pts
 *
 * @param {Object} lead - Validated lead object
 * @returns {{ score: number, breakdown: Object, primaryDomain: string }}
 */
function scoreLead(lead) {
  const breakdown = {};

  // Revenue score (0–30)
  const rev = lead.annual_revenue || 0;
  breakdown.revenue = rev >= 50_000_000 ? 30
    : rev >= 20_000_000 ? 22
    : rev >= 10_000_000 ? 15
    : rev >= 5_000_000  ? 10
    : 5;

  // Headcount score (0–15)
  const emp = lead.employee_count || 0;
  breakdown.headcount = emp >= 1000 ? 15
    : emp >= 500 ? 12
    : emp >= 200 ? 9
    : emp >= 50  ? 6
    : 2;

  // Seniority score (0–15)
  const title = (lead.title || '').toLowerCase();
  breakdown.seniority =
    ['ceo','cto','cfo','coo','founder','co-founder','president'].some(t => title.includes(t)) ? 15 :
    ['vp','vice president','director','head of'].some(t => title.includes(t))                 ? 10 :
    ['manager','lead','principal'].some(t => title.includes(t))                               ? 6  : 2;

  // Source quality score (0–10)
  const sourceMap = {
    'Partner Referral': 10, 'Conference': 8, 'Webinar': 6,
    'LinkedIn': 5, 'Form': 3, 'Unknown': 0
  };
  breakdown.source_quality = sourceMap[lead.source] || 0;

  const baseScore = breakdown.revenue + breakdown.headcount +
                    breakdown.seniority + breakdown.source_quality;

  // AI/ML domain score (0–85)
  const industry = (lead.industry || '').toLowerCase();
  let aiScore = 0;
  if (AI_INDUSTRIES.has(industry)) aiScore += 20;
  aiScore += { high: 40, medium: 25, low: 10, none: 0 }[lead.ai_adoption_interest] || 0;
  aiScore += { 'cloud-native': 30, hybrid: 20, 'on-premise': 10, none: 0 }[lead.compute_readiness] || 0;
  aiScore += Math.min((Array.isArray(lead.tech_stack) ? lead.tech_stack.length : 0) * 3, 15);
  breakdown.ai_domain = aiScore;

  // Financial domain score (0–95)
  let finScore = 0;
  if (FINTECH_INDUSTRIES.has(industry)) finScore += 20;
  if (lead.regulatory_domain) finScore += 15;
  finScore += { enterprise: 40, 'mid-market': 25, smb: 10 }[lead.transaction_scale] || 0;
  finScore += Math.min((Array.isArray(lead.fintech_keywords) ? lead.fintech_keywords.length : 0) * 5, 20);
  breakdown.financial_domain = finScore;

  // Determine primary domain and final score
  let primaryDomain = 'GENERAL';
  let totalScore    = baseScore;

  if (aiScore > 10 || finScore > 10) {
    if (aiScore >= finScore) {
      primaryDomain = 'AI_ML';
      totalScore    = baseScore + aiScore;
    } else {
      primaryDomain = 'FINANCIAL';
      totalScore    = baseScore + finScore;
    }
  }

  return { score: totalScore, breakdown, primaryDomain };
}

// ─── Qualification Gate ───────────────────────────────────────────────────────

/**
 * Applies score thresholds to determine final lead state.
 *
 * @param {Object} lead - Scored lead with _score_total and _primary_domain
 * @returns {string} Final state
 */
function qualifyLead(lead) {
  const score     = lead._score_total || 0;
  const domain    = lead._primary_domain || 'GENERAL';
  const threshold = SCORE_THRESHOLDS[domain] ?? 55;

  if (score < threshold) {
    return STATES.DISQUALIFIED;
  }
  return domain === 'FINANCIAL'
    ? STATES.QUALIFIED_FINANCIAL
    : STATES.QUALIFIED_AI_LEAD;
}

// ─── Pipeline Orchestrator ────────────────────────────────────────────────────

/**
 * Runs the full lead enrichment pipeline on a batch of raw leads.
 *
 * @param {Object[]} rawLeads - Input lead records
 * @returns {Object} Enrichment report with categorized leads
 */
function runPipeline(rawLeads) {
  const startTime = Date.now();
  console.log(`\n${'═'.repeat(60)}`);
  console.log(`  Lead Enrichment Pipeline v2.1.0`);
  console.log(`  Started: ${new Date().toISOString()}`);
  console.log(`${'═'.repeat(60)}\n`);

  // ── Stage 0: Tag as NEW ─────────────────────────────────────
  const tagged = rawLeads.map(l => ({
    ...l,
    _state:      STATES.NEW,
    _ingested_at: new Date().toISOString()
  }));

  // ── Stage 1: Deduplication ─────────────────────────────────
  console.log(`[STAGE 1] Deduplication — ${tagged.length} leads ingested`);
  const { unique, duplicates } = deduplicateLeads(tagged);
  console.log(`  ✓ Unique: ${unique.length}  |  Duplicates removed: ${duplicates.length}`);

  // ── Stage 2: Syntax Validation ──────────────────────────────
  console.log(`\n[STAGE 2] Syntax Validation`);
  const validated    = [];
  const rejected     = [...duplicates.map(l => ({
    ...l, _state: STATES.DISQUALIFIED,
    _disqualify_reasons: [l._duplicate_of],
    _disqualified_at: new Date().toISOString()
  }))];

  for (const lead of unique) {
    const { valid, reasons } = validateLead(lead);
    if (valid) {
      lead._state        = STATES.VALIDATED;
      lead._validated_at = new Date().toISOString();
      validated.push(lead);
      console.log(`  ✅ VALIDATED — ${lead.email}`);
    } else {
      lead._state               = STATES.DISQUALIFIED;
      lead._disqualify_reasons  = reasons;
      lead._disqualified_at     = new Date().toISOString();
      rejected.push(lead);
      console.log(`  ❌ REJECTED  — ${lead.email || 'NO_EMAIL'} [${reasons.join(', ')}]`);
    }
  }

  // ── Stage 3: Scoring ────────────────────────────────────────
  console.log(`\n[STAGE 3] Scoring Engine — ${validated.length} leads`);
  for (const lead of validated) {
    const { score, breakdown, primaryDomain } = scoreLead(lead);
    lead._state           = STATES.SCORED;
    lead._score_total     = score;
    lead._score_breakdown = breakdown;
    lead._primary_domain  = primaryDomain;
    lead._scored_at       = new Date().toISOString();
    console.log(`  📊 ${lead.email.padEnd(40)} score=${String(score).padStart(3)} domain=${primaryDomain}`);
  }

  // ── Stage 4: Qualification Gate ─────────────────────────────
  console.log(`\n[STAGE 4] Qualification Gate`);
  const aiLeads  = [];
  const finLeads = [];

  for (const lead of validated) {
    const finalState = qualifyLead(lead);
    lead._state = finalState;

    if (finalState === STATES.QUALIFIED_AI_LEAD) {
      lead._qualified_at = new Date().toISOString();
      aiLeads.push(lead);
      console.log(`  🤖 AI QUALIFIED   — ${lead.email} (score: ${lead._score_total})`);
    } else if (finalState === STATES.QUALIFIED_FINANCIAL) {
      lead._qualified_at = new Date().toISOString();
      finLeads.push(lead);
      console.log(`  💰 FIN QUALIFIED  — ${lead.email} (score: ${lead._score_total})`);
    } else {
      lead._disqualify_reasons = lead._disqualify_reasons || [];
      lead._disqualify_reasons.push(
        `SCORE_BELOW_THRESHOLD_${SCORE_THRESHOLDS[lead._primary_domain]}_ACTUAL_${lead._score_total}`
      );
      lead._disqualified_at = new Date().toISOString();
      rejected.push(lead);
      console.log(`  ⛔ DISQUALIFIED   — ${lead.email} (score: ${lead._score_total})`);
    }
  }

  // ── Summary ─────────────────────────────────────────────────
  const elapsed = Date.now() - startTime;
  const summary = {
    run_id:              `RUN-${Date.now()}`,
    timestamp:           new Date().toISOString(),
    pipeline_version:    '2.1.0',
    elapsed_ms:          elapsed,
    total_ingested:      rawLeads.length,
    total_deduplicated:  duplicates.length,
    total_validated:     validated.length,
    total_ai_qualified:  aiLeads.length,
    total_fin_qualified: finLeads.length,
    total_disqualified:  rejected.length,
    avg_score_qualified: (() => {
      const all = [...aiLeads, ...finLeads];
      return all.length > 0
        ? Math.round(all.reduce((s, l) => s + l._score_total, 0) / all.length)
        : 0;
    })(),
    top_lead: (() => {
      const all = [...aiLeads, ...finLeads];
      return all.sort((a, b) => b._score_total - a._score_total)[0] || null;
    })()
  };

  console.log(`\n${'═'.repeat(60)}`);
  console.log('  PIPELINE SUMMARY');
  console.log(`${'─'.repeat(60)}`);
  console.log(`  Total Ingested    : ${summary.total_ingested}`);
  console.log(`  Duplicates Removed: ${summary.total_deduplicated}`);
  console.log(`  AI Qualified      : ${summary.total_ai_qualified}`);
  console.log(`  Fin Qualified     : ${summary.total_fin_qualified}`);
  console.log(`  Disqualified      : ${summary.total_disqualified}`);
  console.log(`  Avg Score (Qual.) : ${summary.avg_score_qualified}`);
  if (summary.top_lead) {
    console.log(`  Top Lead          : ${summary.top_lead.name} @ ${summary.top_lead.company} (${summary.top_lead._score_total} pts)`);
  }
  console.log(`  Elapsed           : ${elapsed}ms`);
  console.log(`${'═'.repeat(60)}\n`);

  return {
    summary,
    ai_leads:     aiLeads,
    fin_leads:    finLeads,
    disqualified: rejected
  };
}

// ─── Sample Data & CLI Entry Point ────────────────────────────────────────────

const SAMPLE_LEADS = [
  {
    id: 'L001', name: 'Priya Sharma', email: 'priya.sharma@techventures.io',
    company: 'TechVentures AI', title: 'CTO', domain: 'techventures.io',
    annual_revenue: 12000000, employee_count: 220, industry: 'Artificial Intelligence',
    ai_adoption_interest: 'high', compute_readiness: 'cloud-native',
    tech_stack: ['AWS', 'Kubernetes', 'TensorFlow'], country: 'IN', source: 'LinkedIn'
  },
  {
    id: 'L002', name: 'James Harrington', email: 'j.harrington@quantumfinance.com',
    company: 'Quantum Finance Corp', title: 'VP Operations', domain: 'quantumfinance.com',
    annual_revenue: 85000000, employee_count: 1500, industry: 'Financial Services',
    regulatory_domain: 'SEC', transaction_scale: 'enterprise',
    fintech_keywords: ['derivatives', 'risk management', 'compliance'],
    country: 'US', source: 'Webinar'
  },
  {
    id: 'L003', name: 'Bad Lead', email: 'not-a-valid-email', company: '',
    title: '', domain: 'spam.biz', annual_revenue: 0, employee_count: 0,
    industry: 'Unknown', country: 'XX', source: 'Unknown'
  },
  {
    id: 'L004', name: 'Sofia Andersen', email: 'sofia@nordichealthtech.dk',
    company: 'Nordic HealthTech', title: 'Head of AI Research', domain: 'nordichealthtech.dk',
    annual_revenue: 9500000, employee_count: 180, industry: 'HealthTech',
    ai_adoption_interest: 'medium', compute_readiness: 'hybrid',
    tech_stack: ['Azure', 'PyTorch'], country: 'DK', source: 'Conference'
  },
  {
    id: 'L005', name: 'Raj Patel', email: 'raj.patel@fintechbridge.com',
    company: 'FinTechBridge Ltd', title: 'CEO', domain: 'fintechbridge.com',
    annual_revenue: 32000000, employee_count: 420, industry: 'FinTech',
    regulatory_domain: 'FCA', transaction_scale: 'mid-market',
    fintech_keywords: ['payments', 'blockchain', 'AML'], country: 'GB', source: 'Partner Referral'
  },
  {
    id: 'L004', name: 'Sofia Andersen (DUPLICATE)', email: 'sofia@nordichealthtech.dk',
    company: 'Nordic HealthTech', title: 'Head of AI Research', domain: 'nordichealthtech.dk',
    annual_revenue: 9500000, employee_count: 180, industry: 'HealthTech',
    ai_adoption_interest: 'medium', compute_readiness: 'hybrid',
    tech_stack: ['Azure', 'PyTorch'], country: 'DK', source: 'Conference'
  }
];

// CLI execution
if (require.main === module) {
  let inputLeads = SAMPLE_LEADS;

  // Support --input flag for external JSON file
  const inputFlag = process.argv.indexOf('--input');
  if (inputFlag !== -1 && process.argv[inputFlag + 1]) {
    const fs   = require('fs');
    const path = require('path');
    const file = path.resolve(process.argv[inputFlag + 1]);
    if (fs.existsSync(file)) {
      inputLeads = JSON.parse(fs.readFileSync(file, 'utf-8'));
      console.log(`Loaded ${inputLeads.length} leads from ${file}`);
    } else {
      console.error(`File not found: ${file}`);
      process.exit(1);
    }
  }

  const result = runPipeline(inputLeads);

  // Output full JSON result to stdout if --json flag provided
  if (process.argv.includes('--json')) {
    process.stdout.write(JSON.stringify(result, null, 2) + '\n');
  }
}

// Export for use as a module
module.exports = {
  EMAIL_REGEX,
  DOMAIN_REGEX,
  BLOCKLIST_DOMAINS,
  SCORE_THRESHOLDS,
  STATES,
  validateLead,
  deduplicateLeads,
  scoreLead,
  qualifyLead,
  runPipeline
};
