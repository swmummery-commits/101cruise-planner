(function (global) {
  "use strict";

  function placeShipSpotlightNav() {
    const menu = document.getElementById("admin-nav-menu-marketing");
    if (!menu) return;

    const allSpotlightButtons = Array.from(document.querySelectorAll('[data-ship-spotlight-nav]'));
    let button = allSpotlightButtons.find((node) => node.parentElement === menu) || null;

    allSpotlightButtons.forEach((node) => {
      if (node !== button) node.remove();
    });

    if (!button) {
      button = document.createElement("button");
      button.type = "button";
      button.setAttribute("role", "menuitem");
      button.className = "admin-nav-leaf";
      button.dataset.shipSpotlightNav = "true";
      button.innerHTML = "<span>Ship Spotlight</span>";
      button.addEventListener("click", function (event) {
        event.stopPropagation();
        if (global.ShipSpotlightAdmin?.open) global.ShipSpotlightAdmin.open();
      });
    }

    const newsletter = Array.from(menu.querySelectorAll(".admin-nav-leaf"))
      .find((node) => node !== button) || null;

    if (!newsletter) {
      if (button.parentElement !== menu) menu.appendChild(button);
      return;
    }

    if (button.parentElement !== menu || button.previousElementSibling !== newsletter) {
      newsletter.insertAdjacentElement("afterend", button);
    }
  }

  placeShipSpotlightNav();
  new MutationObserver(placeShipSpotlightNav).observe(document.documentElement, {
    childList: true,
    subtree: true
  });
})(window);
