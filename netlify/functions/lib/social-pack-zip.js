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
    cruiseFolder.file("01-hero.png", pack.slides["01-hero.png"]);
    cruiseFolder.file("02-journey.png", pack.slides["02-journey.png"]);
    cruiseFolder.file("03-offer.png", pack.slides["03-offer.png"]);
    cruiseFolder.file("caption.txt", pack.caption || "");
    manifest.cruises.push({
      featured_cruise_id: pack.id,
      public_slug: pack.publicSlug || null,
      folder: pack.folderSlug,
      files: ["01-hero.png", "02-journey.png", "03-offer.png", "caption.txt"],
      warnings: pack.readiness?.warnings || [],
      readiness: pack.readiness?.label || null,
      public_price:
        pack.offer != null
          ? {
              room_label: pack.offer.roomLabel,
              cruise_101_price: pack.offer.cruise101Price
            }
          : null
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
