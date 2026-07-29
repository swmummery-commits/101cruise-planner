/**
 * ZIP assembly for Social Pack downloads.
 */

const JSZip = require("jszip");

async function buildSocialPackZip({ newsletterNumber, packs, generatedAt = new Date().toISOString() }) {
  const zip = new JSZip();
  const root = `newsletter-${newsletterNumber}-social-pack`;
  const folder = zip.folder(root);
  const manifest = {
    newsletter_number: Number(newsletterNumber),
    generated_at: generatedAt,
    cruises: []
  };

  for (const pack of packs) {
    const cruiseFolder = folder.folder(pack.folderSlug);
    const slideNames = Object.keys(pack.slides || {});
    for (const name of slideNames) {
      cruiseFolder.file(name, pack.slides[name]);
    }
    cruiseFolder.file("caption.txt", pack.caption || "");
    const files = [...slideNames, "caption.txt"];
    manifest.cruises.push({
      featured_cruise_id: pack.id,
      public_slug: pack.publicSlug || null,
      folder: pack.folderSlug,
      files,
      warnings: pack.readiness?.warnings || [],
      readiness: pack.readiness?.label || null,
      background: {
        media_id: pack.backgroundMediaId || null,
        title: pack.backgroundTitle || null,
        destination_key: pack.backgroundDestinationKey || null,
        match_role: pack.backgroundMatchRole || null,
        rotation_index: pack.backgroundRotationIndex ?? null,
        treatment: pack.treatment || null
      },
      public_prices: (pack.offers || []).map((o) => ({
        room_label: o.roomLabel,
        cruise_101_price: o.cruise101Price
      }))
    });
  }

  folder.file("manifest.json", JSON.stringify(manifest, null, 2));
  const buffer = await zip.generateAsync({
    type: "nodebuffer",
    compression: "DEFLATE",
    compressionOptions: { level: 6 }
  });
  return {
    buffer,
    filename: `newsletter-${newsletterNumber}-social-pack.zip`,
    manifest
  };
}

module.exports = { buildSocialPackZip };
