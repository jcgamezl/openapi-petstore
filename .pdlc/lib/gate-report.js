'use strict';

// Renders a gate report as lines. Extracted from bin/spine.js so it can
// be tested directly: spine.js has no `require.main` guard, so requiring
// it to reach the printer would run the CLI.
//
// Returns lines rather than writing them, so a test asserts on the text
// without capturing console.

function approverLabel(approval) {
  // An approval is either a role name or a strategy object. The object
  // renders as the roles it actually wants — never as [object Object],
  // which is what a bare interpolation produces.
  if (approval && typeof approval === 'object') {
    return (approval.roles || [approval.role]).filter(Boolean).join(' + ');
  }
  return approval;
}

function badgeFor(r) {
  if (r.approved) return 'OK ';
  // DECLINED is not BLOCKED: a declined gate needs a conversation, a
  // blocked one needs a signature. Reporting both the same way sends
  // someone chasing a signature that has already been refused.
  if (r.verdict === 'declined') return 'DECLINED';
  return r.required ? 'BLOCKED' : 'open';
}

function formatGateReport(report) {
  const lines = [];
  const who = report.ticket_id ? `ticket: ${report.ticket_id}  ` : '';
  if (report.done) {
    lines.push(`${who}track "${report.track}": complete, nothing left to gate.`);
    return lines;
  }
  lines.push(`${who}phase: ${report.phase}${report.post_hoc ? ' (post-hoc)' : ''}  track: ${report.track}`);
  for (const r of report.results) {
    const wants = approverLabel(r.approval);
    const role = wants ? ` (approver: ${wants})` : '';
    lines.push(
      `  [${badgeFor(r)}] ${r.artifact}${role}`
      + `${r.required ? '' : ' (supporting)'}`
      + `${r.reason ? ' — ' + r.reason : ''}`
    );
  }
  if (report.trackCheck && !report.trackCheck.ok) lines.push(`  [BLOCKED] ${report.trackCheck.reason}`);
  if (report.escalation && report.escalation.reason) {
    lines.push(`  [${report.escalation.ok ? 'WARN' : 'BLOCKED'}] ${report.escalation.reason}`);
  }
  lines.push(report.ok ? 'gate: CLEAR — ready to advance' : 'gate: NOT CLEAR');
  return lines;
}

module.exports = { formatGateReport, approverLabel, badgeFor };
