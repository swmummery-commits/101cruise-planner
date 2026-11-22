// Search a bounded distance from a confidently matched town. The normal marine
// router still validates the resulting leg against land.
function nearestCoastalWater(latitude, longitude, isLand) {
  const latScale = Math.cos(latitude * Math.PI / 180);
  if (Math.abs(latScale) < 0.1) return null;
  for (const kilometres of [0.5, 1, 2, 3, 5, 8]) {
    for (let direction = 0; direction < 16; direction++) {
      const angle = direction * Math.PI / 8;
      const lat = latitude + kilometres * Math.sin(angle) / 111;
      const lon = (longitude + kilometres * Math.cos(angle) / (111 * latScale) + 540) % 360 - 180;
      if (!isLand(lon, lat)) return { latitude: lat, longitude: lon };
    }
  }
  return null;
}

module.exports = { nearestCoastalWater };
