/* Newsletter-only presentation for Paul's Tip.
 * Keep the dynamic Ship Spotlight page unchanged. In the newsletter, Paul's Tip
 * follows the overview as a normal paragraph with the same typography/alignment.
 */
(function (global) {
  "use strict";

  const MARKER = 'data-cr101-pauls-tip="1"';

  function simplifyPaulsTip(html) {
    const source = String(html || "");
    const markerAt = source.indexOf(MARKER);
    if (markerAt < 0) return source;

    const rowStart = source.lastIndexOf("<tr", markerAt);
    const rowEndMarker = "</tr></table></td></tr>";
    const rowEndAt = source.indexOf(rowEndMarker, markerAt);
    if (rowStart < 0 || rowEndAt < 0) return source;

    const rowEnd = rowEndAt + rowEndMarker.length;
    const oldRow = source.slice(rowStart, rowEnd);
    const titleEndMarker = "PAUL'S TIP</div>";
    const titleEnd = oldRow.indexOf(titleEndMarker);
    if (titleEnd < 0) return source;

    const tipDivStart = oldRow.indexOf("<div", titleEnd + titleEndMarker.length);
    const tipContentStart = tipDivStart >= 0 ? oldRow.indexOf(">", tipDivStart) + 1 : -1;
    const tipContentEnd = tipContentStart > 0 ? oldRow.indexOf("</div>", tipContentStart) : -1;
    if (tipContentStart <= 0 || tipContentEnd < 0) return source;

    const tipHtml = oldRow.slice(tipContentStart, tipContentEnd);
    const newRow = `<tr ${MARKER}><td align="center" style="padding:12px 16px 0;font-family:Helvetica,Arial,sans-serif;font-size:14px;font-weight:400;color:#111111;text-align:center;line-height:1.65;">${tipHtml}</td></tr>`;

    return `${source.slice(0, rowStart)}${newRow}${source.slice(rowEnd)}`;
  }

  function install() {
    const api = global.ShipSpotlightAdmin;
    if (!api || typeof api.emailHtml !== "function" || api.__paulsTipNewsletterParagraphInstalled) return;
    const original = api.emailHtml.bind(api);
    api.emailHtml = function () {
      return simplifyPaulsTip(original());
    };
    api.__paulsTipNewsletterParagraphInstalled = true;
  }

  install();

  global.ShipSpotlightPaulsTipNewsletterStyle = {
    simplifyPaulsTip
  };
})(window);
