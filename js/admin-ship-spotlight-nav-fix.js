(function (global) {
  "use strict";

  function placeShipSpotlightNav() {
    const menu = document.getElementById("admin-nav-menu-marketing");
    if (!menu) return;

    document.querySelectorAll('[data-ship-spotlight-nav]').forEach((node) => {
      if (node.parentElement !== menu) node.remove();
    });

    let button = menu.querySelector('[data-ship-spotlight-nav]');
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
    } else {
      button.className = "admin-nav-leaf";
      button.setAttribute("role", "menuitem");
      button.innerHTML = "<span>Ship Spotlight</span>";
    }

    const newsletter = menu.querySelector(".admin-nav-leaf");
    if (newsletter && newsletter !== button) {
      newsletter.insertAdjacentElement("afterend", button);
    } else if (button.parentElement !== menu) {
      menu.appendChild(button);
    }
  }

  placeShipSpotlightNav();
  new MutationObserver(placeShipSpotlightNav).observe(document.documentElement, {
    childList: true,
    subtree: true
  });
})(window);
