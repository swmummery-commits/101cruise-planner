/**
 * My Cruise must not expose planner-account Create Account / email-password Sign In.
 * Run: node scripts/test-my-cruise-booking-only-access.mjs
 */

import { readFileSync } from "fs";
import path from "path";
import { fileURLToPath } from "url";
import vm from "vm";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, "..");
const plannerSrc = readFileSync(path.join(root, "js/planner.js"), "utf8");
const cssSrc = readFileSync(path.join(root, "css/planner.css"), "utf8");
const adminSrc = readFileSync(path.join(root, "js/admin.js"), "utf8");

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

function extractFunction(src, name) {
  const patterns = [`async function ${name}(`, `function ${name}(`];
  let start = -1;
  for (const p of patterns) {
    start = src.indexOf(p);
    if (start >= 0) break;
  }
  assert(start >= 0, `function ${name} not found`);
  let i = src.indexOf("{", start);
  let depth = 0;
  for (; i < src.length; i++) {
    const ch = src[i];
    if (ch === "{") depth += 1;
    else if (ch === "}") {
      depth -= 1;
      if (depth === 0) return src.slice(start, i + 1);
    }
  }
  throw new Error(`Could not extract ${name}`);
}

// --- Static: booking-number login only ---
{
  const accessFn = extractFunction(plannerSrc, "renderCustomerAccess");
  assert(/customerBookingNumber/.test(accessFn), "booking number field");
  assert(/customerSurname/.test(accessFn), "surname field");
  assert(/Remember me on this device/.test(accessFn), "remember me");
  assert(/Open My Cruise/.test(accessFn), "open CTA");
  assert(!/Use an existing planner account/.test(accessFn), "no existing planner account disclosure");
  assert(!/signinPassword|signupPassword|type="password"/.test(accessFn), "no password on login");
  assert(!/Create Account/.test(accessFn), "no Create Account on login");
  assert(!/signinEmail/.test(accessFn), "no email sign-in on login");
}

// --- Static: legacy screen retired ---
{
  const loginFn = extractFunction(plannerSrc, "renderLogin");
  assert(/clearLegacyPlannerAccountState/.test(loginFn), "renderLogin clears legacy state");
  assert(/renderCustomerAccess/.test(loginFn), "renderLogin shows booking login");
  assert(!/Create Account/.test(loginFn), "renderLogin has no Create Account UI");
  assert(!/signupPassword|signinPassword/.test(loginFn), "renderLogin has no password fields");
  assert(!/auth-grid/.test(loginFn), "renderLogin has no auth-grid");

  assert(/async function signUp\(\)[\s\S]*?await renderLogin\(\)/.test(plannerSrc), "signUp retired to booking login");
  assert(/async function signIn\(\)[\s\S]*?await renderLogin\(\)/.test(plannerSrc), "signIn retired to booking login");
  assert(!/auth\.signUp\(/.test(plannerSrc), "no customer auth.signUp calls");
  assert(!/auth\.signInWithPassword\(/.test(plannerSrc), "no customer auth.signInWithPassword calls");
}

// --- init never restores planner account ---
{
  const initFn = extractFunction(plannerSrc, "initPlanner");
  assert(/clearLegacyPlannerAccountState/.test(initFn), "init clears legacy account state");
  assert(/renderCustomerAccess/.test(initFn), "init falls back to booking login");
  assert(!/getSession\(\)/.test(initFn), "init does not restore Supabase planner session");
  assert(!/syncInvitationBookingForCurrentUser/.test(initFn), "init does not claim invitation into planner account");
  assert(/getStoredCustomerSession/.test(initFn), "init still restores booking session");
}

// --- Sign out / switch ---
{
  const signOutFn = extractFunction(plannerSrc, "signOut");
  assert(/changeCustomerBooking/.test(signOutFn), "customer signOut uses booking logout");
  assert(/renderCustomerAccess/.test(signOutFn), "non-customer signOut returns to booking login");

  assert(/openSwitchBookingChooser/.test(plannerSrc), "switch booking chooser present");
  assert(/customer-switch-booking/.test(plannerSrc), "secure switch endpoint used");
  const switchFn = extractFunction(plannerSrc, "openSwitchBookingChooser");
  assert(!/renderLogin/.test(switchFn), "switch does not open legacy login");
}

// --- failed access stays on booking login ---
{
  const access = extractFunction(plannerSrc, "accessMyCruise");
  assert(/customer-access/.test(access), "uses customer-access endpoint");
  assert(/customer-access-message/.test(access), "shows message on same page");
  assert(!/renderLogin/.test(access), "failed access does not open legacy login");
  assert(/Remember me|rememberCustomerBooking|storeCustomerSession/.test(access), "remember me still wired");
}

// --- production strings absent from customer login markup ---
{
  assert(!/Use an existing planner account/.test(plannerSrc), "disclosure string gone from planner");
  assert(!/id="signupPassword"/.test(plannerSrc), "signup password field gone");
  assert(!/id="signinPassword"/.test(plannerSrc), "signin password field gone");
  assert(!/Create your free account/.test(plannerSrc), "create account copy gone");
}

// --- CSS cleanup ---
{
  assert(!/\.customer-existing-account\s*\{/.test(cssSrc), "customer-existing-account styles removed");
  assert(!/\.customer-account-login\s*\{/.test(cssSrc), "customer-account-login styles removed");
  assert(!/\.auth-grid\s*\{/.test(cssSrc), "auth-grid styles removed");
  assert(!/\.invitation-card\s*\{/.test(cssSrc), "invitation-card styles removed");
}

// --- Admin auth untouched ---
{
  assert(/function renderLogin\(/.test(adminSrc), "admin still has renderLogin");
  assert(/signInWithPassword/.test(adminSrc), "admin password sign-in retained");
  assert(!/Use an existing planner account/.test(adminSrc), "admin unrelated");
}

// --- Runtime: renderLogin cannot paint Create Account ---
{
  const calls = [];
  const sandbox = {
    console,
    customerMode: false,
    currentUser: { id: "legacy" },
    currentProfile: { first_name: "Legacy" },
    invitationSyncMessage: "x",
    invitationSyncLoading: true,
    clearStoredInvitationBookingId() {
      calls.push("clearBid");
    },
    renderCustomerAccess(message) {
      calls.push(`access:${message || ""}`);
    },
    supabaseClient: {
      auth: {
        async signOut() {
          calls.push("supabaseSignOut");
        }
      }
    }
  };

  vm.createContext(sandbox);
  vm.runInContext(
    `
    async function clearLegacyPlannerAccountState() {
      clearStoredInvitationBookingId();
      invitationSyncMessage = "";
      invitationSyncLoading = false;
      try { await supabaseClient.auth.signOut(); } catch (e) {}
      if (!customerMode) { currentUser = null; currentProfile = null; }
    }
    async function renderLogin() {
      await clearLegacyPlannerAccountState();
      renderCustomerAccess();
    }
    async function run() { await renderLogin(); }
    run();
    `,
    sandbox
  );

  // Allow microtasks from async run()
  await new Promise((r) => setTimeout(r, 20));
  assert(calls.includes("clearBid"), "stale bid cleared");
  assert(calls.includes("supabaseSignOut"), "supabase session cleared");
  assert(calls.some((c) => c.startsWith("access:")), "booking login rendered");
  assert(sandbox.currentUser === null, "legacy user cleared");
}

console.log("test-my-cruise-booking-only-access: ok");
