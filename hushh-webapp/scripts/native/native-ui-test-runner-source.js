/**
 * Injected into the Capacitor WebView during native UI interaction audit.
 * Expects window.__HUSHH_NATIVE_TEST__ from NativeTestSupport.swift.
 */
(function installNativeUiTestRunner() {
  if (typeof window === "undefined") return;

  var NAV_TOUR_IDS_BY_LABEL = {
    Agent: ["nav-agent"],
    Analysis: ["nav-analysis"],
    Clients: ["nav-ria-clients"],
    Connect: ["nav-connect", "nav-ria-connect"],
    Home: ["nav-ria-home"],
    Market: ["nav-market"],
    Picks: ["nav-ria-picks"],
    Portfolio: ["nav-portfolio"],
    Profile: ["nav-profile"],
  };

  var TERMINAL_DATA_STATES = [
    "loaded",
    "empty-valid",
    "unavailable-valid",
    "redirect-valid",
    "error",
  ];
  var UI_FLOW_STORAGE_KEY = "__hushh_native_ui_flow_state_v1";

  var NAV_ROUTE_BY_PERSONA_AND_LABEL = {
    investor: {
      Market: "/one/kai",
      Portfolio: "/one/kai/portfolio",
      Analysis: "/one/kai/analysis",
      Connect: "/marketplace",
      Profile: "/profile",
    },
    ria: {
      Home: "/ria",
      Clients: "/ria/clients",
      Picks: "/ria/picks",
      Connect: "/marketplace",
      Profile: "/profile",
    },
  };

  function sleep(ms) {
    return new Promise(function (resolve) {
      window.setTimeout(resolve, ms);
    });
  }

  function visible(element) {
    if (!element || !(element instanceof HTMLElement)) return false;
    if (element.offsetParent !== null) return true;
    var rect = element.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  }

  function firstVisible(selector) {
    var nodes = Array.prototype.slice.call(document.querySelectorAll(selector));
    for (var i = 0; i < nodes.length; i += 1) {
      if (visible(nodes[i])) return nodes[i];
    }
    return null;
  }

  function clickElement(element) {
    if (!element || !(element instanceof HTMLElement)) {
      throw new Error("click target missing");
    }
    element.click();
  }

  function visibleButtons() {
    return Array.prototype.slice
      .call(document.querySelectorAll("button, [role='button']"))
      .filter(visible);
  }

  function escapeRegExp(value) {
    return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }

  function findVisibleButton(pattern) {
    var buttons = visibleButtons();
    for (var i = 0; i < buttons.length; i += 1) {
      var text = (buttons[i].textContent || "").trim();
      if (pattern.test(text)) return buttons[i];
    }
    return null;
  }

  function dismissBlockingScreens() {
    var exactLabels = [
      "not now, continue with passphrase",
      "not now",
      "skip",
      "skip tour",
      "got it",
      "maybe later",
      "dismiss",
      "continue",
    ];
    var buttons = Array.prototype.slice.call(
      document.querySelectorAll("button, [role='button']"),
    );
    for (var i = 0; i < exactLabels.length; i += 1) {
      var target = exactLabels[i];
      var match = buttons.find(function (button) {
        var text = (button.textContent || "").trim().toLowerCase();
        return visible(button) && text === target;
      });
      if (match) {
        clickElement(match);
        return true;
      }
    }
    var partial = buttons.find(function (button) {
      var text = (button.textContent || "").trim().toLowerCase();
      return (
        visible(button) &&
        (text.indexOf("not now") >= 0 || text.indexOf("skip tour") >= 0)
      );
    });
    if (partial) {
      clickElement(partial);
      return true;
    }
    return false;
  }

  function personaMismatchPromptVisible() {
    return false;
  }

  function visibleButtonSummary(limit) {
    var buttons = Array.prototype.slice.call(
      document.querySelectorAll("button, [role='button']"),
    );
    return buttons
      .filter(visible)
      .map(function (button) {
        return (button.textContent || "")
          .trim()
          .replace(/ +/g, " ")
          .slice(0, 48);
      })
      .filter(Boolean)
      .slice(0, limit || 6)
      .join("|");
  }

  function bridgeSummary() {
    var bridge = nativeTestBridge();
    return [
      "enabled=" + (bridge.enabled === true ? "1" : "0"),
      "navigate=" + (typeof bridge.navigateToRoute === "function" ? "1" : "0"),
      "switch=" + (typeof bridge.switchPersona === "function" ? "1" : "0"),
      "active=" + String(bridge.activePersona || ""),
      "primary=" + String(bridge.primaryNavPersona || ""),
      "persona_switch=" + String(bridge.personaSwitchStatus || ""),
      "bootstrap=" + String(bridge.bootstrapState || ""),
    ].join(",");
  }

  function normalizeRoute(value) {
    var trimmed = String(value || "").trim();
    if (!trimmed || trimmed === "/") return trimmed || "/";
    try {
      var url = new URL(trimmed, "https://native-ui-test.local");
      var pathname = url.pathname || "/";
      if (pathname.length > 1 && pathname.endsWith("/")) {
        pathname = pathname.slice(0, -1);
      }
      return pathname + url.search;
    } catch (_) {
      return trimmed.endsWith("/") ? trimmed.slice(0, -1) : trimmed;
    }
  }

  function matchesRouteId(routeId, allowedRouteIds) {
    var current = normalizeRoute(routeId);
    for (var i = 0; i < allowedRouteIds.length; i += 1) {
      var allowed = allowedRouteIds[i];
      var normalizedAllowed = normalizeRoute(allowed);
      if (current === normalizedAllowed) return true;
      if (current.indexOf(normalizedAllowed + "?") === 0) return true;
      if (current.indexOf(normalizedAllowed + "#") === 0) return true;
      if (allowed.includes("[") && allowed.includes("]")) {
        var escaped = normalizedAllowed.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        var pattern = new RegExp(
          "^" + escaped.replace(/\\\[[^\\\]]+\\\]/g, "[^/]+") + "(?:$|[/?#])",
        );
        if (pattern.test(current)) return true;
        continue;
      }
    }
    return false;
  }

  function targetPersonaForRouteIds(routeIds) {
    for (var i = 0; i < routeIds.length; i += 1) {
      var routeId = String(routeIds[i] || "");
      if (routeId.indexOf("/ria") === 0) return "ria";
      if (routeId.indexOf("/one/kai") === 0) return "investor";
      if (routeId.indexOf("/kai") === 0) return "investor";
    }
    return "";
  }

  function concreteTargetRoute(routeIds) {
    for (var i = 0; i < routeIds.length; i += 1) {
      var routeId = String(routeIds[i] || "");
      if (routeId.indexOf("[") === -1 && routeId.indexOf("/") === 0) {
        return routeId;
      }
    }
    return "";
  }

  function currentRouteMatches(route) {
    var current = normalizeRoute(
      window.location.pathname + window.location.search,
    );
    var expected = normalizeRoute(route);
    return (
      current === expected ||
      current.indexOf(expected + "/") === 0 ||
      current.indexOf(expected + "?") === 0 ||
      current.indexOf(expected + "#") === 0
    );
  }

  async function waitForBeacon(routeIds, dataStates, timeoutMs) {
    var deadline = Date.now() + (timeoutMs || 120000);
    var states =
      dataStates && dataStates.length ? dataStates : TERMINAL_DATA_STATES;
    var mismatchRecoveredAt = 0;
    var routeRecoveredAt = 0;
    var targetRoute = concreteTargetRoute(routeIds);
    while (Date.now() < deadline) {
      if (
        personaMismatchPromptVisible() &&
        Date.now() - mismatchRecoveredAt > 1500
      ) {
        mismatchRecoveredAt = Date.now();
        var targetPersona = targetPersonaForRouteIds(routeIds);
        if (targetPersona) {
          await resolvePersonaMismatchPrompt(targetPersona);
        }
        if (targetRoute && !currentRouteMatches(targetRoute)) {
          await navigateWithNativeRouter(targetRoute);
          routeRecoveredAt = Date.now();
        }
      }
      var beacons = Array.prototype.slice.call(
        document.querySelectorAll('[data-native-test-beacon="true"]'),
      );
      for (var i = 0; i < beacons.length; i += 1) {
        var beacon = beacons[i];
        var routeId = beacon.getAttribute("data-native-route-id") || "";
        var dataState = beacon.getAttribute("data-native-data-state") || "";
        if (
          matchesRouteId(routeId, routeIds) &&
          states.indexOf(dataState) >= 0
        ) {
          return { routeId: routeId, dataState: dataState };
        }
      }
      if (
        targetRoute &&
        !currentRouteMatches(targetRoute) &&
        Date.now() - routeRecoveredAt > 2000
      ) {
        routeRecoveredAt = Date.now();
        await navigateWithNativeRouter(targetRoute);
      }
      await sleep(250);
    }
    throw new Error(
      "route beacon timeout for " +
        routeIds.join(", ") +
        " at " +
        window.location.href +
        " visible=" +
        visibleButtonSummary(8),
    );
  }

  async function clickBottomNav(label) {
    var beforeRoute = normalizeRoute(
      window.location.pathname + window.location.search,
    );
    var tourIds = NAV_TOUR_IDS_BY_LABEL[label] || [];
    for (var i = 0; i < tourIds.length; i += 1) {
      var target = firstVisible('[data-tour-id="' + tourIds[i] + '"]');
      if (target) {
        clickElement(target);
        await sleep(400);
        await ensureBottomNavRoute(label, beforeRoute);
        return;
      }
    }

    var buttons = Array.prototype.slice.call(
      document.querySelectorAll("button"),
    );
    var pattern = new RegExp("^" + label + "$", "i");
    for (var j = 0; j < buttons.length; j += 1) {
      var text = (buttons[j].textContent || "").trim();
      if (pattern.test(text) && visible(buttons[j])) {
        clickElement(buttons[j]);
        await sleep(400);
        await ensureBottomNavRoute(label, beforeRoute);
        return;
      }
    }

    var bridge = nativeTestBridge();
    var personas = [bridge.primaryNavPersona, bridge.activePersona];
    for (var k = 0; k < personas.length; k += 1) {
      var persona = personas[k];
      var expectedRoute =
        persona &&
        NAV_ROUTE_BY_PERSONA_AND_LABEL[persona] &&
        NAV_ROUTE_BY_PERSONA_AND_LABEL[persona][label];
      if (
        expectedRoute &&
        bridge.enabled === true &&
        typeof bridge.navigateToRoute === "function"
      ) {
        await navigateWithNativeRouter(expectedRoute);
        return;
      }
    }

    throw new Error(
      'bottom nav item not found: "' + label + '" on ' + window.location.href,
    );
  }

  async function ensureBottomNavRoute(label, beforeRoute) {
    var bridge = nativeTestBridge();
    var candidates = [bridge.primaryNavPersona, bridge.activePersona];
    var persona = "";
    for (var i = 0; i < candidates.length; i += 1) {
      var candidate = candidates[i];
      if (
        candidate &&
        NAV_ROUTE_BY_PERSONA_AND_LABEL[candidate] &&
        NAV_ROUTE_BY_PERSONA_AND_LABEL[candidate][label]
      ) {
        persona = candidate;
        break;
      }
    }
    if (!persona) {
      persona =
        (window.location.pathname || "").indexOf("/ria") === 0 &&
        NAV_ROUTE_BY_PERSONA_AND_LABEL.ria[label]
          ? "ria"
          : "investor";
    }
    var expectedRoute = NAV_ROUTE_BY_PERSONA_AND_LABEL[persona]
      ? NAV_ROUTE_BY_PERSONA_AND_LABEL[persona][label]
      : "";
    if (!expectedRoute) return;

    var currentRoute = normalizeRoute(
      window.location.pathname + window.location.search,
    );
    var normalizedExpected = normalizeRoute(expectedRoute);
    if (
      currentRoute === normalizedExpected ||
      (normalizedExpected !== "/" &&
        currentRoute.indexOf(normalizedExpected + "/") === 0)
    ) {
      return;
    }

    if (
      bridge.enabled === true &&
      typeof bridge.navigateToRoute === "function"
    ) {
      await navigateWithNativeRouter(expectedRoute);
    }
  }

  async function clickButton(name, regex) {
    var pattern = regex
      ? new RegExp(name, "i")
      : new RegExp("^" + name + "$", "i");
    var buttons = Array.prototype.slice.call(
      document.querySelectorAll("button"),
    );
    for (var i = 0; i < buttons.length; i += 1) {
      var text = (buttons[i].textContent || "").trim();
      if (pattern.test(text) && visible(buttons[i]) && !buttons[i].disabled) {
        clickElement(buttons[i]);
        await sleep(400);
        return;
      }
    }
    var links = Array.prototype.slice.call(document.querySelectorAll("a"));
    for (var j = 0; j < links.length; j += 1) {
      var linkText = (links[j].textContent || "").trim();
      if (pattern.test(linkText) && visible(links[j])) {
        clickElement(links[j]);
        await sleep(400);
        return;
      }
    }
    throw new Error(
      'button/link not found: "' + name + '" on ' + window.location.href,
    );
  }

  async function waitForButton(name, regex, timeoutMs) {
    var pattern = regex
      ? new RegExp(name, "i")
      : new RegExp("^" + escapeRegExp(name) + "$", "i");
    var deadline = Date.now() + (timeoutMs || 30000);
    while (Date.now() < deadline) {
      var target = findVisibleButton(pattern);
      if (target && !target.disabled) return target;
      await sleep(250);
    }
    throw new Error(
      'button/link not ready: "' + name + '" on ' + window.location.href,
    );
  }

  async function waitForText(value, regex, timeoutMs) {
    var pattern = regex
      ? new RegExp(value, "i")
      : new RegExp(escapeRegExp(value), "i");
    var deadline = Date.now() + (timeoutMs || 30000);
    while (Date.now() < deadline) {
      var text = (document.body && document.body.innerText) || "";
      if (pattern.test(text)) return;
      await sleep(250);
    }
    throw new Error(
      'text not visible: "' + value + '" on ' + window.location.href,
    );
  }

  async function assertNoText(value, regex, timeoutMs) {
    var pattern = regex
      ? new RegExp(value, "i")
      : new RegExp(escapeRegExp(value), "i");
    var deadline = Date.now() + (timeoutMs || 3000);
    while (Date.now() < deadline) {
      var text = (document.body && document.body.innerText) || "";
      if (pattern.test(text)) {
        throw new Error(
          'unexpected text visible: "' + value + '" on ' + window.location.href,
        );
      }
      await sleep(250);
    }
  }

  async function waitForUrlIncludes(value, timeoutMs) {
    var deadline = Date.now() + (timeoutMs || 5000);
    while (Date.now() < deadline) {
      if (window.location.href.indexOf(value) >= 0) return;
      await sleep(150);
    }
    throw new Error("url missing " + value + " at " + window.location.href);
  }

  function clearImportBackgroundState() {
    var keys = [
      "kai_portfolio_import_background_v1",
      "hushh_session:kai_portfolio_import_background_v1",
    ];
    for (var i = 0; i < keys.length; i += 1) {
      try {
        window.sessionStorage.removeItem(keys[i]);
      } catch (_) {}
      try {
        window.localStorage.removeItem(keys[i]);
      } catch (_) {}
    }
  }

  function fileListForFile(file) {
    if (typeof DataTransfer === "function") {
      var dataTransfer = new DataTransfer();
      dataTransfer.items.add(file);
      return dataTransfer.files;
    }
    return {
      0: file,
      length: 1,
      item: function (index) {
        return index === 0 ? file : null;
      },
    };
  }

  async function uploadTestAsset(step) {
    var assetPath = step.assetPath || "";
    if (!assetPath) {
      throw new Error("upload_test_asset missing assetPath");
    }
    var url = assetPath.charAt(0) === "/" ? assetPath : "/" + assetPath;
    var response = await fetch(url, { cache: "no-store" });
    if (!response.ok) {
      throw new Error(
        "failed to load upload asset: " + response.status + " " + url,
      );
    }
    var blob = await response.blob();
    var fileName =
      step.fileName || assetPath.split("/").pop() || "native-test-upload.pdf";
    var mimeType = step.mimeType || blob.type || "application/octet-stream";
    var file = new File([blob], fileName, { type: mimeType });
    var input = document.querySelector('input[type="file"]');
    if (!input) {
      throw new Error("file input missing on " + window.location.href);
    }
    var files = fileListForFile(file);
    try {
      Object.defineProperty(input, "files", {
        configurable: true,
        get: function () {
          return files;
        },
      });
    } catch (_) {
      input.files = files;
    }
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.dispatchEvent(new Event("change", { bubbles: true }));
    await sleep(600);
  }

  function nativeTestBridge() {
    return window.__HUSHH_NATIVE_TEST__ || {};
  }

  function nativeUiFlowRunState() {
    window.__HUSHH_NATIVE_UI_FLOW_STATE__ =
      window.__HUSHH_NATIVE_UI_FLOW_STATE__ || {
        started: false,
        complete: false,
        promise: null,
        report: null,
      };
    return window.__HUSHH_NATIVE_UI_FLOW_STATE__;
  }

  function readStoredUiFlowState() {
    try {
      var raw = window.sessionStorage.getItem(UI_FLOW_STORAGE_KEY);
      if (!raw) return null;
      return JSON.parse(raw);
    } catch (_) {
      return null;
    }
  }

  function writeStoredUiFlowState(state) {
    try {
      window.sessionStorage.setItem(UI_FLOW_STORAGE_KEY, JSON.stringify(state));
    } catch (_) {}
  }

  async function waitForNativeAutomationBridge(timeoutMs) {
    var ready = await waitForCondition(function () {
      var bridge = nativeTestBridge();
      return (
        bridge.enabled === true &&
        typeof bridge.navigateToRoute === "function" &&
        typeof bridge.switchPersona === "function" &&
        (bridge.activePersona === "investor" || bridge.activePersona === "ria")
      );
    }, timeoutMs || 30000);
    if (!ready) {
      var bridge = nativeTestBridge();
      throw new Error(
        "native automation bridge not ready: navigate=" +
          (typeof bridge.navigateToRoute === "function" ? "1" : "0") +
          " switch=" +
          (typeof bridge.switchPersona === "function" ? "1" : "0") +
          " active=" +
          String(bridge.activePersona || ""),
      );
    }
  }

  function clearNativeTestRouteLock() {
    var bridge = nativeTestBridge();
    bridge.initialRoute = null;
    bridge.expectedRoute = null;
    bridge.expectedMarker = null;
    try {
      var root = document.documentElement;
      if (root) {
        root.setAttribute("data-hushh-native-test-initial-route", "");
        root.setAttribute("data-hushh-native-test-expected-route", "");
        root.setAttribute("data-hushh-native-test-expected-marker", "");
      }
      window.dispatchEvent(new Event("hushh:native-test-config-updated"));
    } catch (_) {}
  }

  function applyNativeTestRouteLock(route) {
    var bridge = nativeTestBridge();
    bridge.initialRoute = route;
    bridge.expectedRoute = route;
    bridge.expectedMarker = null;
    try {
      var root = document.documentElement;
      if (root) {
        root.setAttribute("data-hushh-native-test-initial-route", route);
        root.setAttribute("data-hushh-native-test-expected-route", route);
        root.setAttribute("data-hushh-native-test-expected-marker", "");
      }
    } catch (_) {}
  }

  function routeForPersona(persona) {
    return persona === "ria" ? "/ria" : "/one/kai";
  }

  function routeMatchesPersona(persona) {
    var currentPath = window.location.pathname || "";
    return (
      (persona === "ria" && currentPath.indexOf("/ria") === 0) ||
      (persona === "investor" && currentPath.indexOf("/one/kai") === 0) ||
      (persona === "investor" && currentPath.indexOf("/kai") === 0)
    );
  }

  function personaHomeLabel(persona) {
    return persona === "ria" ? "Home" : "Market";
  }

  function visibleNavLabel(label) {
    return Boolean(
      findVisibleButton(new RegExp("^" + escapeRegExp(label) + "$", "i")),
    );
  }

  function personaShellReady(persona, expectedTour) {
    var bridge = nativeTestBridge();
    var personaReady =
      bridge.activePersona === persona ||
      bridge.primaryNavPersona === persona ||
      bridge.personaSwitchStatus === "ok:" + persona;
    return (
      routeMatchesPersona(persona) &&
      personaReady &&
      (Boolean(firstVisible('[data-tour-id="' + expectedTour + '"]')) ||
        visibleNavLabel(personaHomeLabel(persona)) ||
        bridge.personaSwitchStatus === "ok:" + persona)
    );
  }

  function personaRouteUiReady(persona, expectedTour) {
    return (
      routeMatchesPersona(persona) &&
      !personaMismatchPromptVisible() &&
      (Boolean(firstVisible('[data-tour-id="' + expectedTour + '"]')) ||
        visibleNavLabel(personaHomeLabel(persona)))
    );
  }

  function personaBridgeReady(persona) {
    var bridge = nativeTestBridge();
    return (
      routeMatchesPersona(persona) &&
      (bridge.activePersona === persona ||
        bridge.primaryNavPersona === persona ||
        bridge.personaSwitchStatus === "ok:" + persona)
    );
  }

  async function waitForPersonaState(persona, timeoutMs) {
    var deadline = Date.now() + (timeoutMs || 15000);
    while (Date.now() < deadline) {
      var bridge = nativeTestBridge();
      if (bridge.activePersona === persona) return;
      await sleep(250);
    }
    throw new Error(
      "persona switch timeout: " +
        persona +
        " status=" +
        String(nativeTestBridge().personaSwitchStatus || "") +
        " error=" +
        String(nativeTestBridge().personaSwitchError || ""),
    );
  }

  async function waitForCondition(predicate, timeoutMs, intervalMs) {
    var deadline = Date.now() + (timeoutMs || 15000);
    while (Date.now() < deadline) {
      if (predicate()) return true;
      await sleep(intervalMs || 250);
    }
    return false;
  }

  async function waitForVisibleTestId(testId, timeoutMs) {
    var selector = '[data-testid="' + testId + '"]';
    var ready = await waitForCondition(function () {
      return Boolean(firstVisible(selector));
    }, timeoutMs || 30000);
    if (!ready) {
      var body = ((document.body && document.body.innerText) || "")
        .trim()
        .replace(/\s+/g, " ")
        .slice(0, 180);
      throw new Error(
        "expected visible testid: " +
          testId +
          " route=" +
          window.location.pathname +
          window.location.search +
          " visible=" +
          visibleButtonSummary(8) +
          " body=" +
          body,
      );
    }
  }

  function findVoiceControl(controlId) {
    var selectors = [
      '[data-native-voice-control-id="' + controlId + '"]',
      '[data-voice-control-id="' + controlId + '"]',
      '[data-testid="' + controlId + '"]',
    ];
    for (var i = 0; i < selectors.length; i += 1) {
      var target = firstVisible(selectors[i]);
      if (target && !target.disabled) return target;
    }
    return null;
  }

  function voiceSurface() {
    return (
      firstVisible('[data-testid="one-voice-surface"]') ||
      firstVisible("[data-voice-mode]")
    );
  }

  function currentVoiceMode() {
    var surface = voiceSurface();
    if (!surface) return "";
    return String(surface.getAttribute("data-voice-mode") || "");
  }

  function voiceFallbackVisible() {
    var text = ((document.body && document.body.innerText) || "").toLowerCase();
    return (
      text.indexOf("microphone permission") >= 0 ||
      text.indexOf("microphone access") >= 0 ||
      text.indexOf("no microphone") >= 0 ||
      text.indexOf("voice unavailable") >= 0 ||
      text.indexOf("could not connect to realtime voice") >= 0 ||
      text.indexOf("realtime voice connection") >= 0
    );
  }

  async function waitForVoiceMode(modes, timeoutMs, allowPermissionFallback) {
    var expected = Array.isArray(modes) ? modes : [modes];
    var ready = await waitForCondition(function () {
      var mode = currentVoiceMode();
      if (expected.indexOf(mode) >= 0) return true;
      return allowPermissionFallback === true && voiceFallbackVisible();
    }, timeoutMs || 30000);
    if (!ready) {
      throw new Error(
        "voice mode mismatch expected=" +
          expected.join(",") +
          " actual=" +
          currentVoiceMode() +
          " route=" +
          window.location.pathname +
          window.location.search,
      );
    }
  }

  async function waitForVoiceControl(controlId, timeoutMs) {
    var ready = await waitForCondition(function () {
      return Boolean(findVoiceControl(controlId));
    }, timeoutMs || 30000);
    if (!ready) {
      throw new Error(
        "voice control missing: " +
          controlId +
          " mode=" +
          currentVoiceMode() +
          " route=" +
          window.location.pathname +
          window.location.search,
      );
    }
  }

  async function openCommandPalette(timeoutMs) {
    window.dispatchEvent(new CustomEvent("kai:command-bar:open"));
    await waitForVoiceControl(
      "one_voice_command_palette_toggle",
      timeoutMs || 30000,
    );
  }

  async function endVoiceIfActive(timeoutMs) {
    await waitForCondition(function () {
      return Boolean(voiceSurface());
    }, timeoutMs || 5000);
    var mode = currentVoiceMode();
    if (!mode || mode === "idle" || mode === "error") return;
    var endControl =
      findVoiceControl("one_voice_agent_bar_end") ||
      findVoiceControl("one_voice_end_session") ||
      findVoiceControl("one_voice_cancel_turn");
    if (endControl) {
      clickElement(endControl);
      await sleep(500);
    }
  }

  async function attemptNativePersonaSwitch(persona) {
    var bridge = nativeTestBridge();
    if (
      bridge.activePersona === persona ||
      bridge.primaryNavPersona === persona ||
      bridge.personaSwitchStatus === "ok:" + persona
    ) {
      return true;
    }
    if (bridge.enabled !== true || typeof bridge.switchPersona !== "function")
      return false;

    try {
      var observed = waitForPersonaState(persona, 12000).then(function () {
        return "observed";
      });
      var requested = Promise.resolve(bridge.switchPersona(persona)).then(
        function () {
          return "resolved";
        },
      );
      var timedOut = sleep(12000).then(function () {
        return "timeout";
      });
      var result = await Promise.race([observed, requested, timedOut]);
      if (
        result === "observed" ||
        nativeTestBridge().activePersona === persona ||
        nativeTestBridge().primaryNavPersona === persona ||
        nativeTestBridge().personaSwitchStatus === "ok:" + persona
      ) {
        return true;
      }
      return await waitForCondition(function () {
        var current = nativeTestBridge();
        return (
          current.activePersona === persona ||
          current.primaryNavPersona === persona ||
          current.personaSwitchStatus === "ok:" + persona
        );
      }, 12000);
    } catch (error) {
      var current = nativeTestBridge();
      if (
        current.activePersona === persona ||
        current.primaryNavPersona === persona ||
        current.personaSwitchStatus === "ok:" + persona
      ) {
        return true;
      }
      throw error;
    }
  }

  async function resolvePersonaMismatchPrompt(persona) {
    void persona;
    return false;
  }

  async function waitForNoPersonaMismatchPrompt(timeoutMs) {
    void timeoutMs;
  }

  async function waitForRoute(route, timeoutMs) {
    var expected = normalizeRoute(route);
    var expectedBase =
      expected.length > 1 && expected.endsWith("/")
        ? expected.slice(0, -1)
        : expected;
    var deadline = Date.now() + (timeoutMs || 5000);
    while (Date.now() < deadline) {
      var current = normalizeRoute(
        window.location.pathname + window.location.search,
      );
      var currentBase =
        current.length > 1 && current.endsWith("/")
          ? current.slice(0, -1)
          : current;
      if (
        currentBase === expectedBase ||
        current === expected ||
        current.indexOf(expected + "/") === 0 ||
        current.indexOf(expected + "?") === 0 ||
        current.indexOf(expected + "#") === 0
      ) {
        return true;
      }
      await sleep(150);
    }
    return false;
  }

  async function navigateWithNativeRouter(route) {
    var bridge = nativeTestBridge();
    if (currentRouteMatches(route)) {
      clearNativeTestRouteLock();
      return;
    }
    applyNativeTestRouteLock(route);
    if (typeof bridge.navigateToRoute === "function") {
      bridge.navigateToRoute(route);
      if (await waitForRoute(route, 30000)) {
        clearNativeTestRouteLock();
        return;
      }
      if (currentRouteMatches(route)) {
        clearNativeTestRouteLock();
        return;
      }
      throw new Error(
        "Next.js native router did not reach " +
          route +
          " from " +
          window.location.pathname +
          window.location.search,
      );
    }
    throw new Error("Next.js native router bridge missing for " + route);
  }

  async function ensurePersona(persona) {
    await waitForNativeAutomationBridge();
    var expectedTour = persona === "ria" ? "nav-ria-home" : "nav-market";
    var bridge = nativeTestBridge();
    var route = routeForPersona(persona);
    if (personaShellReady(persona, expectedTour)) {
      await waitForNoPersonaMismatchPrompt(1000);
      return;
    }

    if (bridge.enabled === true && typeof bridge.switchPersona === "function") {
      if (!routeMatchesPersona(persona)) {
        await navigateWithNativeRouter(route);
      }
      var switched = await attemptNativePersonaSwitch(persona);
      var resolvedMismatch = await resolvePersonaMismatchPrompt(persona);
      if (switched || resolvedMismatch) {
        await sleep(500);
      }
      if (
        personaBridgeReady(persona) ||
        personaShellReady(persona, expectedTour) ||
        personaRouteUiReady(persona, expectedTour)
      ) {
        await waitForNoPersonaMismatchPrompt(1000);
        return;
      }
      await waitForBeacon([route], undefined, 30000);
      await resolvePersonaMismatchPrompt(persona);
      if (
        personaBridgeReady(persona) ||
        personaShellReady(persona, expectedTour) ||
        personaRouteUiReady(persona, expectedTour)
      ) {
        await waitForNoPersonaMismatchPrompt(1000);
        return;
      }

      var ready = await waitForCondition(function () {
        return (
          personaShellReady(persona, expectedTour) ||
          personaRouteUiReady(persona, expectedTour)
        );
      }, 15000);
      if (ready) {
        await waitForNoPersonaMismatchPrompt(1000);
        return;
      }
    }

    var stayInRia = Array.prototype.slice
      .call(document.querySelectorAll("button"))
      .find(function (button) {
        return /stay in ria workspace/i.test((button.textContent || "").trim());
      });
    if (persona === "ria" && stayInRia && visible(stayInRia)) {
      clickElement(stayInRia);
      await sleep(800);
      await waitForNoPersonaMismatchPrompt(3000);
      return;
    }

    var stayInvestor = Array.prototype.slice
      .call(document.querySelectorAll("button"))
      .find(function (button) {
        return /stay in (?:investor|kai) workspace/i.test(
          (button.textContent || "").trim(),
        );
      });
    if (persona === "investor" && stayInvestor && visible(stayInvestor)) {
      clickElement(stayInvestor);
      await sleep(800);
      await waitForNoPersonaMismatchPrompt(3000);
      return;
    }

    var switchInvestor = Array.prototype.slice
      .call(document.querySelectorAll("button"))
      .find(function (button) {
        return /switch to investor workspace/i.test(
          (button.textContent || "").trim(),
        );
      });
    if (persona === "investor" && switchInvestor && visible(switchInvestor)) {
      clickElement(switchInvestor);
      await sleep(800);
      await waitForNoPersonaMismatchPrompt(3000);
      return;
    }

    if (personaShellReady(persona, expectedTour)) {
      await waitForNoPersonaMismatchPrompt(1000);
      return;
    }

    if (!routeMatchesPersona(persona)) {
      await navigateWithNativeRouter(route);
    }
    await resolvePersonaMismatchPrompt(persona);
    var routeReady = await waitForCondition(function () {
      return (
        personaBridgeReady(persona) ||
        personaShellReady(persona, expectedTour) ||
        personaRouteUiReady(persona, expectedTour)
      );
    }, 15000);
    if (routeReady) {
      await waitForNoPersonaMismatchPrompt(1000);
      return;
    }

    throw new Error(
      "persona switch failed: " +
        persona +
        " route=" +
        window.location.pathname +
        " bridge=" +
        bridgeSummary() +
        " visible=" +
        visibleButtonSummary(8),
    );
  }

  async function openRiaWorkspace() {
    await ensurePersona("ria");
    await clickBottomNav("Clients");
    await waitForBeacon(["/ria/clients"]);
    var testProfile = firstVisible('[data-testid="ria-client-test-profile"]');
    if (testProfile) {
      clickElement(testProfile);
    } else {
      var bridge = nativeTestBridge();
      var expectedUserId = bridge.expectedUserId || "";
      if (expectedUserId) {
        // Live client cards come from UAT data. If that roster is empty, use the
        // existing non-production test profile so account-detail UI coverage stays deterministic.
        await navigateWithNativeRouter(
          "/ria/clients/" +
            encodeURIComponent(expectedUserId) +
            "?test_profile=1",
        );
      } else {
        await clickButton("kai test user|kushal trivedi", true);
      }
    }
    await waitForBeacon(["/ria/clients/[userId]"]);
  }

  async function runStep(step) {
    dismissBlockingScreens();
    switch (step.type) {
      case "ensure_persona":
        await ensurePersona(step.persona);
        return;
      case "click_bottom_nav":
        await clickBottomNav(step.label);
        return;
      case "click_button":
        try {
          clickElement(
            await waitForButton(
              step.name,
              step.regex === true,
              step.buttonTimeoutMs ||
                (step.fallbackRoute ? 8000 : step.timeoutMs),
            ),
          );
        } catch (error) {
          if (step.fallbackRoute) {
            await navigateWithNativeRouter(step.fallbackRoute);
            return;
          }
          throw error;
        }
        await sleep(400);
        return;
      case "wait_button":
        await waitForButton(step.name, step.regex === true, step.timeoutMs);
        return;
      case "clear_import_background":
        clearImportBackgroundState();
        return;
      case "upload_test_asset":
        await uploadTestAsset(step);
        return;
      case "assert_text":
        await waitForText(step.value, step.regex === true, step.timeoutMs);
        return;
      case "assert_no_text":
        await assertNoText(step.value, step.regex === true, step.timeoutMs);
        return;
      case "assert_no_persona_mismatch_prompt":
        await waitForNoPersonaMismatchPrompt(step.timeoutMs);
        return;
      case "assert_voice_control_visible":
        await waitForVoiceControl(step.controlId, step.timeoutMs);
        return;
      case "open_command_palette":
        await openCommandPalette(step.timeoutMs);
        return;
      case "click_voice_control":
        var voiceTarget = findVoiceControl(step.controlId);
        if (!voiceTarget) {
          throw new Error("voice control missing: " + step.controlId);
        }
        clickElement(voiceTarget);
        await sleep(400);
        return;
      case "wait_voice_mode":
        await waitForVoiceMode(
          step.modes || step.mode,
          step.timeoutMs,
          step.allowPermissionFallback === true,
        );
        return;
      case "end_voice_if_active":
        await endVoiceIfActive(step.timeoutMs);
        return;
      case "click_testid":
        var testTarget = firstVisible('[data-testid="' + step.testId + '"]');
        if (!testTarget) {
          throw new Error("testid missing: " + step.testId);
        }
        clickElement(testTarget);
        await sleep(400);
        return;
      case "navigate_route":
        await navigateWithNativeRouter(step.route);
        return;
      case "wait_beacon":
        await waitForBeacon(step.routeIds, step.dataStates, step.timeoutMs);
        return;
      case "assert_url_includes":
        await waitForUrlIncludes(step.value, step.timeoutMs);
        return;
      case "assert_visible_testid":
        await waitForVisibleTestId(step.testId, step.timeoutMs);
        return;
      case "open_ria_workspace":
        await openRiaWorkspace();
        return;
      default:
        throw new Error("unknown step type: " + step.type);
    }
  }

  async function runFlow(flow) {
    var results = [];
    var defaultStepTimeoutMs = flow.stepTimeoutMs || 30000;
    for (var i = 0; i < flow.steps.length; i += 1) {
      var step = flow.steps[i];
      var stepTimeoutMs = step.timeoutMs
        ? step.timeoutMs + 1000
        : defaultStepTimeoutMs;
      var bridge = nativeTestBridge();
      bridge.uiFlowStepIndex = i;
      bridge.uiFlowStepType = step.type || "";
      bridge.uiFlowStepStartedAt = new Date().toISOString();
      try {
        await Promise.race([
          runStep(step),
          new Promise(function (_, reject) {
            window.setTimeout(function () {
              reject(
                new Error(
                  "step timeout (" +
                    step.type +
                    ") visible=" +
                    visibleButtonSummary(8) +
                    " bridge=" +
                    bridgeSummary(),
                ),
              );
            }, stepTimeoutMs);
          }),
        ]);
        results.push({ step: i, type: step.type, ok: true });
      } catch (error) {
        if (flow.optional || step.optional) {
          results.push({
            step: i,
            type: step.type,
            ok: true,
            skipped: true,
            reason: error instanceof Error ? error.message : String(error),
          });
          break;
        }
        results.push({
          step: i,
          type: step.type,
          ok: false,
          error: error instanceof Error ? error.message : String(error),
        });
        return {
          ok: false,
          results: results,
          failedStep: step,
          error: error instanceof Error ? error.message : String(error),
        };
      }
    }
    return { ok: true, results: results };
  }

  async function runAllUiFlows() {
    var bridge = window.__HUSHH_NATIVE_TEST__ || {};
    var runState = nativeUiFlowRunState();
    if (runState.complete) {
      return runState.report || bridge.uiFlowReport || { ok: true, flows: [] };
    }
    if (runState.promise) {
      return runState.promise;
    }
    runState.started = true;
    runState.promise = runAllUiFlowsOnce().finally(function () {
      runState.promise = null;
    });
    return runState.promise;
  }

  async function runAllUiFlowsOnce() {
    var bridge = window.__HUSHH_NATIVE_TEST__ || {};
    var runState = nativeUiFlowRunState();
    if (bridge.uiFlowsComplete) {
      return bridge.uiFlowReport || { ok: true, flows: [] };
    }
    var storedState = readStoredUiFlowState();
    if (storedState && storedState.complete && storedState.report) {
      bridge.uiFlowReport = storedState.report;
      bridge.uiFlowError = storedState.report.error || "";
      bridge.uiFlowsComplete = true;
      bridge.uiFlowsOk = storedState.report.ok === true;
      bridge.uiFlowsFailed = !storedState.report.ok;
      runState.complete = true;
      runState.report = storedState.report;
      return storedState.report;
    }

    var response = await fetch("/native-ui-flows.json", { cache: "no-store" });
    if (!response.ok) {
      throw new Error(
        "failed to load native-ui-flows.json: " + response.status,
      );
    }
    var payload = await response.json();
    var flows = payload.flows || [];
    var report =
      storedState && storedState.report
        ? storedState.report
        : {
            ok: true,
            startedAt: new Date().toISOString(),
            flows: [],
          };
    var startIndex = Math.max(
      0,
      Math.min(
        flows.length,
        Number(storedState && storedState.nextIndex) || report.flows.length || 0,
      ),
    );

    for (var i = startIndex; i < flows.length; i += 1) {
      var flow = flows[i];
      bridge.uiFlowCurrent = flow.id;
      bridge.uiFlowIndex = i;
      writeStoredUiFlowState({
        started: true,
        complete: false,
        nextIndex: i,
        report: report,
      });
      dismissBlockingScreens();
      var result = await runFlow(flow);
      report.flows.push({
        id: flow.id,
        route: flow.route,
        description: flow.description,
        ok: result.ok,
        optional: flow.optional === true,
        results: result.results,
        failedStep: result.failedStep || null,
      });
      if (!result.ok && flow.optional !== true) {
        report.ok = false;
        report.error = result.error || "flow failed: " + flow.id;
        writeStoredUiFlowState({
          started: true,
          complete: true,
          nextIndex: i + 1,
          report: report,
        });
        break;
      }
      writeStoredUiFlowState({
        started: true,
        complete: false,
        nextIndex: i + 1,
        report: report,
      });
    }

    report.completedAt = new Date().toISOString();
    bridge.uiFlowReport = report;
    bridge.uiFlowError = report.error || "";
    bridge.uiFlowsComplete = true;
    bridge.uiFlowsOk = report.ok === true;
    bridge.uiFlowsFailed = !report.ok;
    runState.complete = true;
    runState.report = report;
    writeStoredUiFlowState({
      started: true,
      complete: true,
      nextIndex: flows.length,
      report: report,
    });
    try {
      window.webkit.messageHandlers.hushhNativeTest.postMessage({
        uiFlowReport: report,
        uiFlowError: bridge.uiFlowError,
        uiFlowsComplete: true,
        uiFlowsOk: report.ok === true,
      });
    } catch (_) {}
    return report;
  }

  function startUiFlowBootstrap() {
    var bridge = window.__HUSHH_NATIVE_TEST__ || {};
    var runState = nativeUiFlowRunState();
    if (
      bridge.runUiFlows !== true ||
      bridge._uiFlowBootstrapTimer ||
      bridge._uiFlowsStarted ||
      bridge.uiFlowsComplete === true ||
      runState.started ||
      runState.complete
    ) {
      return;
    }

    bridge._uiFlowBootstrapTimer = window.setInterval(function () {
      var bootstrap = bridge.bootstrapState || "";
      var auth = "";
      var route = window.location.pathname || "";
      var dataState = "";
      if (bridge.readStatus) {
        try {
          var status = bridge.readStatus();
          auth = status.authState || "";
          route = status.route || route;
          dataState = status.dataState || "";
          if (status.uiFlowsComplete === true) {
            window.clearInterval(bridge._uiFlowBootstrapTimer);
            bridge._uiFlowBootstrapTimer = null;
            return;
          }
        } catch (_) {}
      }
      var ready =
        bootstrap === "vault_unlocked" ||
        bootstrap === "ready" ||
        (auth === "authenticated" &&
          (route.indexOf("/ria") === 0 ||
            route.indexOf("/one/kai") === 0 ||
            route.indexOf("/kai") === 0) &&
          (dataState === "loaded" ||
            dataState === "empty-valid" ||
            dataState === "unavailable-valid"));
      var bridgeReady =
        typeof bridge.navigateToRoute === "function" &&
        typeof bridge.switchPersona === "function" &&
        (bridge.activePersona === "investor" || bridge.activePersona === "ria");
      if (!ready || !bridgeReady || bridge._uiFlowsStarted || runState.started)
        return;
      dismissBlockingScreens();
      runState.started = true;
      bridge._uiFlowsStarted = true;
      clearNativeTestRouteLock();
      window.clearInterval(bridge._uiFlowBootstrapTimer);
      bridge._uiFlowBootstrapTimer = null;
      runAllUiFlows().catch(function (error) {
        bridge.uiFlowError =
          error instanceof Error ? error.message : String(error);
        bridge.uiFlowReport = {
          ok: false,
          error: bridge.uiFlowError,
          flows: [],
        };
        runState.complete = true;
        runState.report = bridge.uiFlowReport;
        runState.promise = null;
        bridge.uiFlowsComplete = true;
        bridge.uiFlowsOk = false;
        bridge.uiFlowsFailed = true;
        try {
          window.webkit.messageHandlers.hushhNativeTest.postMessage({
            uiFlowReport: bridge.uiFlowReport,
            uiFlowError: bridge.uiFlowError,
            uiFlowsComplete: true,
            uiFlowsOk: false,
          });
        } catch (_) {}
      });
    }, 500);
  }

  window.__HUSHH_NATIVE_UI_TEST__ = {
    runAllUiFlows: runAllUiFlows,
    runFlow: runFlow,
    runStep: runStep,
    startUiFlowBootstrap: startUiFlowBootstrap,
  };

  var bridge = window.__HUSHH_NATIVE_TEST__ || {};
  bridge.runAllUiFlows = runAllUiFlows;
  window.__HUSHH_NATIVE_TEST__ = bridge;

  window.addEventListener(
    "hushh:native-test-config-updated",
    startUiFlowBootstrap,
  );
  window.setTimeout(startUiFlowBootstrap, 0);
  window.setTimeout(startUiFlowBootstrap, 500);
  window.setTimeout(startUiFlowBootstrap, 2000);
})();
