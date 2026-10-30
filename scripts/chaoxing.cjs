#!/usr/bin/env node
const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const STATE = path.join(ROOT, '.chaoxing-session.json');
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36 Edg/120.0.0.0';
const COURSE_LIST_API = 'https://mooc1-1.chaoxing.com/mooc-ans/visit/courselistdata';
const COURSE_PAGE = 'https://mooc1-1.chaoxing.com/mooc-ans/visit/stucoursemiddle';

function parseArgv(argv) {
  const opts = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next === undefined || next.startsWith('--')) opts[key] = true;
      else { opts[key] = next; i++; }
    } else opts._.push(a);
  }
  return opts;
}

function emit(obj) {
  process.stdout.write(JSON.stringify(obj, null, 1) + '\n');
}

function die(message) {
  emit({ error: message });
  process.exit(1);
}

async function openContext(headless) {
  if (!fs.existsSync(STATE) && headless) die('缺少登录态，先运行: node scripts/chaoxing.cjs login');
  const browser = await chromium.launch({ headless });
  const context = await browser.newContext({
    storageState: fs.existsSync(STATE) ? STATE : undefined,
    locale: 'zh-CN',
    userAgent: UA,
    viewport: { width: 1400, height: 900 }
  });
  return { browser, context };
}

function unescapeHtml(s) {
  return s.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&nbsp;/g, ' ').trim();
}

async function fetchCourses(context) {
  const res = await context.request.post(COURSE_LIST_API, {
    form: { courseType: '1', courseFolderId: '0', baseEducation: '0', superstarClass: '', courseFolderSize: '0' },
    headers: { referer: 'https://i.chaoxing.com/' }
  });
  if (!res.ok()) throw new Error('课程列表接口返回 HTTP ' + res.status());
  const html = await res.text();
  const list = [];
  for (const block of html.split('<li class="course').slice(1)) {
    const courseid = (block.match(/courseId="(\d+)"/) || [])[1];
    const clazzid = (block.match(/clazzId="(\d+)"/) || [])[1];
    if (!courseid || !clazzid) continue;
    const cpi = (block.match(/cpi=(\d+)/) || [])[1] || '';
    const nameHtml = (block.match(/<span class="course-name[^"]*"[^>]*>([\s\S]*?)<\/span>/) || [])[1] || '';
    list.push({ courseid, clazzid, cpi, name: unescapeHtml(nameHtml.replace(/<[^>]+>/g, '')) });
  }
  return [...new Map(list.map(c => [c.courseid + '_' + c.clazzid, c])).values()];
}

async function loadWorkList(page, course) {
  await page.goto(`${COURSE_PAGE}?courseid=${course.courseid}&clazzid=${course.clazzid}&vc=1&cpi=${course.cpi}&ismooc2=1&v=2`, {
    waitUntil: 'domcontentloaded',
    timeout: 60000
  });
  await page.waitForTimeout(3500);
  const clicked = await page.evaluate(() => {
    const el = [...document.querySelectorAll('a,span,li,div')].find(e => e.children.length === 0 && e.textContent.trim() === '作业');
    if (!el) return false;
    el.click();
    return true;
  });
  if (!clicked) return { items: [], error: '未找到作业标签（该课程可能没有作业模块）' };
  let frame = null;
  for (let i = 0; i < 15 && !frame; i++) {
    await page.waitForTimeout(1000);
    frame = page.frames().find(f => f.url().includes('/work/list'));
  }
  if (!frame) return { items: [], error: '作业 iframe 未加载' };
  const items = await frame.evaluate(() => [...document.querySelectorAll('li[onclick*="goTask"]')].map(li => ({
    title: ((li.querySelector('.right-content p:not(.status)') || {}).textContent || '').trim(),
    status: ((li.querySelector('.status') || {}).textContent || '').trim(),
    url: li.getAttribute('data') || ''
  })));
  return { items };
}

async function openWork(page, url) {
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForTimeout(5000);
  if (page.url().includes('/work/preview')) return 'preview';
  if (page.url().includes('/work/dowork')) return 'dowork';
  return 'unknown';
}

async function extractQuestions(page) {
  return page.evaluate(() => {
    const tex = img => {
      const raw = img.getAttribute('data');
      if (raw) {
        try { return decodeURIComponent(raw).replace(/^"|"$/g, ''); } catch (e) { return raw; }
      }
      return img.getAttribute('alt') || '[图片]';
    };
    const textOf = el => {
      const clone = el.cloneNode(true);
      clone.querySelectorAll('img').forEach(img => img.replaceWith(document.createTextNode(' ' + tex(img) + ' ')));
      return clone.textContent.replace(/\u00a0/g, ' ').replace(/\s+/g, ' ').trim();
    };
    return [...document.querySelectorAll('.questionLi')].map((q, idx) => ({
      no: idx + 1,
      qid: q.getAttribute('data') || '',
      type: q.getAttribute('typename') || '',
      stem: q.querySelector('h3') ? textOf(q.querySelector('h3')) : '',
      options: [...q.querySelectorAll('.answerBg')].map(o => ({
        shown: ((o.querySelector('.num_option, .num_option_dx') || {}).textContent || '').trim(),
        canon: ((o.querySelector('.num_option, .num_option_dx') || {}).getAttribute('data') || '').trim(),
        text: o.querySelector('.answer_p') ? textOf(o.querySelector('.answer_p')) : ''
      }))
    }));
  });
}

async function collectState(page, qids) {
  return page.evaluate(ids => {
    const out = {};
    for (const qid of ids) {
      const q = document.querySelector('.questionLi[data="' + qid + '"]');
      out[qid] = q ? [...q.querySelectorAll('.answerBg')]
        .filter(o => (((o.querySelector('.num_option, .num_option_dx') || {}).className) || '').includes('check_answer'))
        .map(o => ((o.querySelector('.num_option, .num_option_dx') || {}).textContent || '').trim()).join('') : 'missing';
    }
    return out;
  }, qids);
}

async function applyAnswers(page, questions, answers) {
  const results = [];
  for (const q of questions) {
    const want = answers[String(q.qid)] || answers[String(q.no)];
    if (!want) { results.push({ no: q.no, skipped: '未提供答案' }); continue; }
    const letters = Array.isArray(want) ? want : String(want).split('');
    const r = await page.evaluate(({ qid, letters }) => {
      const qEl = document.querySelector('.questionLi[data="' + qid + '"]');
      if (!qEl) return { ok: false, why: '题目不存在' };
      const opts = [...qEl.querySelectorAll('.answerBg')];
      if (!opts.length) return { ok: false, why: '非客观题（无选项）' };
      const done = [];
      for (const L of letters) {
        const el = opts.find(o => ((o.querySelector('.num_option, .num_option_dx') || {}).textContent || '').trim() === L);
        if (!el) { done.push('缺少选项:' + L); continue; }
        const span = el.querySelector('.num_option, .num_option_dx');
        if (!(span.className || '').includes('check_answer')) {
          if ((span.className || '').includes('num_option_dx')) addMultipleChoice(el);
          else addChoice(el);
        }
        done.push(L);
      }
      return { ok: true, done };
    }, { qid: q.qid, letters });
    await page.waitForTimeout(120);
    results.push({ no: q.no, want: letters.join(''), ...r });
  }
  return results;
}

async function saveDraft(page) {
  const clicked = await page.evaluate(() => {
    const el = [...document.querySelectorAll('a,button,div,span')].find(e => e.children.length === 0 && /暂时保存/.test(e.textContent));
    if (!el) return false;
    el.click();
    return true;
  });
  await page.waitForTimeout(5000);
  return clicked;
}

async function cmdLogin(opts) {
  const { browser, context } = await openContext(false);
  const page = await context.newPage();
  await page.goto('https://i.chaoxing.com/base', { waitUntil: 'domcontentloaded', timeout: 60000 });
  const deadline = Date.now() + Number(opts.timeout || 300) * 1000;
  let ok = false;
  while (Date.now() < deadline) {
    await page.waitForTimeout(2000);
    if (page.isClosed()) break;
    const names = (await context.cookies().catch(() => [])).map(c => c.name);
    if ((names.includes('_uid') || names.includes('uf')) && !page.url().includes('passport')) { ok = true; break; }
  }
  if (ok) await context.storageState({ path: STATE });
  emit({ loggedIn: ok, statePath: ok ? STATE : null, url: page.url() });
  await browser.close();
}

async function cmdCourses() {
  const { browser, context } = await openContext(true);
  try {
    const courses = await fetchCourses(context);
    emit({ count: courses.length, courses });
  } finally {
    await browser.close();
  }
}

async function cmdScan(opts) {
  const { browser, context } = await openContext(true);
  const page = await context.newPage();
  try {
    const all = await fetchCourses(context);
    const target = opts.course && opts.course !== 'all' ? all.filter(c => c.name === opts.course || c.name.includes(opts.course)) : all;
    const rows = [];
    for (const course of target) {
      const { items, error } = await loadWorkList(page, course);
      const pending = items.filter(i => i.status.includes('未交') || i.status.includes('未完成'));
      const rec = { course: course.name, pending: pending.length, total: items.length, error: error || '', items: [] };
      for (const it of pending) {
        const row = { ...it, mode: '' };
        if (opts.probe) row.mode = await openWork(page, it.url);
        rec.items.push(row);
      }
      rows.push(rec);
    }
    emit({ courses: rows.length, pendingTotal: rows.reduce((n, r) => n + r.pending, 0), rows });
  } finally {
    await browser.close();
  }
}

async function cmdDump(opts) {
  if (!opts.work) die('缺少 --work <作业URL>');
  const { browser, context } = await openContext(true);
  const page = await context.newPage();
  try {
    const mode = await openWork(page, opts.work);
    if (mode === 'preview') { emit({ mode, closed: true, error: '作业已截止，只能查看详情，无法作答' }); return; }
    const questions = await extractQuestions(page);
    const state = await collectState(page, questions.map(q => q.qid));
    const withState = questions.map(q => ({ ...q, selected: state[q.qid] || '' }));
    if (opts.out) fs.writeFileSync(opts.out, JSON.stringify(withState, null, 1), 'utf8');
    emit({ mode, count: questions.length, objective: questions.filter(q => q.options.length > 0).length, out: opts.out || null, questions: withState });
  } finally {
    await browser.close();
  }
}

async function cmdFill(opts) {
  if (!opts.work) die('缺少 --work <作业URL>');
  if (!opts.answers) die('缺少 --answers <答案JSON文件>');
  const answers = JSON.parse(fs.readFileSync(opts.answers, 'utf8'));
  const table = answers.answers || answers;
  const { browser, context } = await openContext(true);
  const page = await context.newPage();
  try {
    const mode = await openWork(page, opts.work);
    if (mode === 'preview') { emit({ mode, closed: true, error: '作业已截止，无法作答' }); return; }
    const questions = await extractQuestions(page);
    const results = opts.dry ? [] : await applyAnswers(page, questions, table);
    const qids = questions.filter(q => q.options.length > 0).map(q => q.qid);
    const before = await collectState(page, qids);
    let saved = false;
    let after = before;
    if (!opts.dry && opts['no-save'] !== true) {
      saved = await saveDraft(page);
      if (saved) {
        await page.reload({ waitUntil: 'domcontentloaded' });
        await page.waitForTimeout(6000);
        after = await collectState(page, qids);
      }
    }
    const check = questions.filter(q => q.options.length > 0 && (table[q.qid] || table[String(q.no)]));
    const mismatches = check.filter(q => {
      const want = Array.isArray(table[q.qid] || table[String(q.no)]) ? (table[q.qid] || table[String(q.no)]).join('') : String(table[q.qid] || table[String(q.no)]);
      const got = (saved ? after : before)[q.qid] || '';
      const norm = s => s.split('').sort().join('');
      return norm(want) !== norm(got);
    }).map(q => ({ no: q.no, want: String(table[q.qid] || table[String(q.no)]), got: (saved ? after : before)[q.qid] || '' }));
    emit({ mode, saved, answered: results.length, mismatches, results });
  } finally {
    await browser.close();
  }
}

async function cmdVerify(opts) {
  if (!opts.work) die('缺少 --work <作业URL>');
  const { browser, context } = await openContext(true);
  const page = await context.newPage();
  try {
    const mode = await openWork(page, opts.work);
    if (mode === 'preview') { emit({ mode, closed: true }); return; }
    const questions = await extractQuestions(page);
    const objective = questions.filter(q => q.options.length > 0);
    const state = await collectState(page, objective.map(q => q.qid));
    emit({
      mode,
      total: questions.length,
      objective: objective.length,
      filled: objective.filter(q => (state[q.qid] || '').length > 0).length,
      selections: objective.map(q => ({ no: q.no, type: q.type, selected: state[q.qid] || '' }))
    });
  } finally {
    await browser.close();
  }
}

async function cmdSubmit(opts) {
  if (!opts.work) die('缺少 --work <作业URL>');
  if (opts.yes !== true) die('提交不可逆，确认后加 --yes');
  const { browser, context } = await openContext(true);
  const page = await context.newPage();
  page.on('dialog', async d => { await d.accept(); });
  try {
    const mode = await openWork(page, opts.work);
    if (mode === 'preview') { emit({ mode, closed: true, error: '作业已截止，无法提交' }); return; }
    const before = await cmdVerifyInPage(page);
    const clicked = await page.evaluate(() => {
      const el = [...document.querySelectorAll('a,button,div,span')].find(e => e.children.length === 0 && e.textContent.trim() === '提交');
      if (!el) return false;
      el.click();
      return true;
    });
    if (!clicked) { emit({ error: '未找到提交按钮', before }); return; }
    await page.waitForTimeout(1500);
    await page.evaluate(() => {
      const el = [...document.querySelectorAll('a,button,div,span')].filter(e => e.children.length === 0 && /^(确定|确认|提交)$/.test(e.textContent.trim())).pop();
      if (el) el.click();
    });
    await page.waitForTimeout(6000);
    emit({ submitted: true, url: page.url(), before });
  } finally {
    await browser.close();
  }
}

function cmdVerifyInPage(page) {
  return page.evaluate(() => {
    const qs = [...document.querySelectorAll('.questionLi')].filter(q => q.querySelector('.answerBg'));
    const filled = qs.filter(q => [...q.querySelectorAll('.num_option, .num_option_dx')].some(s => s.className.includes('check_answer')));
    return { objective: qs.length, filled: filled.length };
  });
}

(async () => {
  const opts = parseArgv(process.argv.slice(2));
  const cmd = opts._[0];
  try {
    if (cmd === 'login') return await cmdLogin(opts);
    if (cmd === 'courses') return await cmdCourses(opts);
    if (cmd === 'scan') return await cmdScan(opts);
    if (cmd === 'dump') return await cmdDump(opts);
    if (cmd === 'fill') return await cmdFill(opts);
    if (cmd === 'verify') return await cmdVerify(opts);
    if (cmd === 'submit') return await cmdSubmit(opts);
    die('用法: node scripts/chaoxing.cjs <login|courses|scan|dump|fill|verify|submit> [选项]');
  } catch (e) {
    emit({ error: e.message });
    process.exit(1);
  }
})();
