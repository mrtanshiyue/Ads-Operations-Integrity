from pathlib import Path

ui_path = Path('assets/cloudflare-native-csv-recommendation-human-review-v1.js')
ui = ui_path.read_text()
ui = ui.replace("const VERSION = '1.4.0';", "const VERSION = '1.5.0';", 1)
if "const VERSION = '1.5.0';" not in ui:
    raise SystemExit('Human Review UI version patch failed')

validation_anchor = """      if (typeof context?.recurrent !== 'boolean') throw new Error('historical_learning_recurrence_invalid');
"""
validation_insert = """      if (typeof context?.recurrent !== 'boolean') throw new Error('historical_learning_recurrence_invalid');
      const historicalNote = context?.latestHistoricalReview?.note;
      if (historicalNote != null && typeof historicalNote !== 'string') throw new Error('historical_learning_rationale_invalid');
"""
if ui.count(validation_anchor) != 1:
    raise SystemExit('historical validation anchor missing or non-unique')
ui = ui.replace(validation_anchor, validation_insert, 1)

drawer_anchor = """      <div><span>Latest observed</span><strong>${esc(context.latestObservedAt || 'unavailable')}</strong></div>
    </div><div class=\"cfri-callout warn\"><strong>Learning boundary:</strong> Recurrence and evidence drift are historical review context only, not effectiveness. No learning weight, rule mutation, recommendation mutation, execution, or Amazon authority is created.</div></div>`;
  }

  function decisionPacketHtml(packet) {
"""
drawer_insert = """      <div><span>Latest observed</span><strong>${esc(context.latestObservedAt || 'unavailable')}</strong></div>
    </div>${historicalRationaleHtml(context)}<div class=\"cfri-callout warn\"><strong>Learning boundary:</strong> Recurrence and evidence drift are historical review context only, not effectiveness. No learning weight, rule mutation, recommendation mutation, execution, or Amazon authority is created.</div></div>`;
  }

  function historicalRationaleHtml(context) {
    const note = String(context?.latestHistoricalReview?.note || '').trim();
    if (!note) return '';
    return `<div class=\"cfhl-rationale\" data-cfhl-rationale><strong>Prior Human Review rationale</strong><p>${esc(note)}</p><small>Historical Human Review context only. This is not current recommendation evidence, effectiveness, execution authority, or Amazon mutation authority.</small></div>`;
  }

  function decisionPacketHtml(packet) {
"""
if ui.count(drawer_anchor) != 1:
    raise SystemExit('historical drawer anchor missing or non-unique')
ui = ui.replace(drawer_anchor, drawer_insert, 1)

style_anchor = ".cfhl-historical-only strong{font-size:9px}.cfhl-drawer{margin:10px 0}.cfhl-drawer h4{margin:0 0 7px}"
style_insert = ".cfhl-historical-only strong{font-size:9px}.cfhl-drawer{margin:10px 0}.cfhl-drawer h4{margin:0 0 7px}.cfhl-rationale{margin:0 0 8px;padding:8px;border:1px solid var(--line);border-radius:8px;background:var(--hover-bg)}.cfhl-rationale strong{display:block;font-size:9px}.cfhl-rationale p{margin:5px 0;font-size:10px;white-space:pre-wrap;overflow-wrap:anywhere}.cfhl-rationale small{font-size:9px;color:var(--muted)}"
if ui.count(style_anchor) != 1:
    raise SystemExit('historical style anchor missing or non-unique')
ui = ui.replace(style_anchor, style_insert, 1)
ui_path.write_text(ui)

review_ui_test_path = Path('scripts/test-recommendation-human-review-ui.mjs')
review_ui_test = review_ui_test_path.read_text()
review_ui_test = review_ui_test.replace("/const VERSION = '1\\.4\\.0'/", "/const VERSION = '1\\.5\\.0'/", 1)
if "/const VERSION = '1\\.5\\.0'/" not in review_ui_test:
    raise SystemExit('Human Review UI version assertion patch failed')
rationale_anchor = """assert.ok(ui.includes('Recurrence and final disposition are not effectiveness. Approved is not executed or successful; rejected is not failed.'),
  'Historical Learning semantics copy must reject disposition effectiveness inference');
"""
rationale_insert = rationale_anchor + """assert.match(ui, /const note = String\\(context\\?\\.latestHistoricalReview\\?\\.note \\|\\| ''\\)\\.trim\\(\\)/,
  'Historical rationale must come directly from latestHistoricalReview.note');
assert.match(ui, /if \\(!note\\) return '';/,
  'Blank historical rationale must stay hidden');
assert.match(ui, /data-cfhl-rationale/,
  'Historical rationale must render inside the existing Historical Learning drawer');
assert.ok(ui.includes('Prior Human Review rationale'),
  'Historical rationale must be explicitly labeled as prior Human Review context');
assert.ok(ui.includes('Historical Human Review context only. This is not current recommendation evidence, effectiveness, execution authority, or Amazon mutation authority.'),
  'Historical rationale UI must preserve evidence/effectiveness/execution/Amazon boundaries');
"""
if review_ui_test.count(rationale_anchor) != 1:
    raise SystemExit('review UI rationale test anchor missing or non-unique')
review_ui_test_path.write_text(review_ui_test.replace(rationale_anchor, rationale_insert, 1))

historical_ui_test_path = Path('scripts/test-historical-review-learning-ui.mjs')
historical_ui_test = historical_ui_test_path.read_text()
historical_anchor = """assert.match(ui, /state\\.historicalCurrentByInboxItem\\.get\\(String\\(inboxItemId \\|\\| ''\\)\\)/,
  'Drawer historical context must bind by current Inbox item ID');
"""
historical_insert = historical_anchor + """
assert.match(ui, /const note = String\\(context\\?\\.latestHistoricalReview\\?\\.note \\|\\| ''\\)\\.trim\\(\\)/,
  'Historical reviewer rationale must be projected from the server latest historical review');
assert.match(ui, /if \\(!note\\) return '';/,
  'Missing or blank historical rationale must not create visual noise');
assert.match(ui, /data-cfhl-rationale/,
  'Historical reviewer rationale must remain inside the existing Historical Learning drawer');
assert.ok(ui.includes('Prior Human Review rationale'),
  'Historical reviewer rationale must be labeled as prior Human Review context');
assert.ok(ui.includes('Historical Human Review context only. This is not current recommendation evidence, effectiveness, execution authority, or Amazon mutation authority.'),
  'Historical reviewer rationale must not be presented as current evidence/effectiveness/execution/Amazon authority');
"""
if historical_ui_test.count(historical_anchor) != 1:
    raise SystemExit('historical UI rationale test anchor missing or non-unique')
historical_ui_test_path.write_text(historical_ui_test.replace(historical_anchor, historical_insert, 1))
