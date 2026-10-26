/**
 * 页壳脚本 —— 独立项目版
 * ============================================================================
 * 这是原来由「个人网站 assets/main.js」承担的部分，现在自带一份。
 * 只做四件事，全部是渐进增强（没有 JS 时页面完全正常，只是不动）：
 *
 *   1. 入场：IntersectionObserver 给 .reveal 加 .is-in
 *   2. 安全网：观察器不回调时兜底显示（防止白屏）
 *   3. 阅读进度线
 *   4. 移动端导航抽屉
 *
 * 不上动效库、不做视差/打字机 —— 番茄钟是工具，动效抢戏就是失败。
 */

(function () {
  "use strict";

  var root = document.documentElement;
  // 只在标记了 .js 时接管（<head> 里已同步加上）
  if (!root.classList.contains("js")) return;

  var reduce =
    window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  /* ------------------------------------------------------------------ *
   * 1 + 2. 入场与安全网
   * ------------------------------------------------------------------ */
  var SELECTOR = ".reveal";

  var revealAll = function () {
    var els = document.querySelectorAll(SELECTOR);
    for (var i = 0; i < els.length; i++) els[i].classList.add("is-in");
  };

  if (reduce) {
    // 边界：减少动效时直接落终态。
    // 不能只把时长压到 0 —— 那样元素会停在 opacity:0 上永远不出现。
    revealAll();
  } else if ("IntersectionObserver" in window) {
    var io = new IntersectionObserver(
      function (entries) {
        entries.forEach(function (entry) {
          if (entry.isIntersecting) {
            entry.target.classList.add("is-in");
            io.unobserve(entry.target);
          }
        });
      },
      { rootMargin: "0px 0px -8% 0px", threshold: 0.01 }
    );

    var targets = document.querySelectorAll(SELECTOR);
    for (var j = 0; j < targets.length; j++) io.observe(targets[j]);

    // 边界：不会白屏。
    // 初始态是 opacity:0，万一观察器一次都不回调
    // （无头环境、虚拟时间、浏览器怪异行为），2.6 秒后强制落终态。
    window.setTimeout(revealAll, 2600);
  } else {
    // 环境不支持观察器
    revealAll();
  }

  /* 首屏元素立即入场，避免出现「空一瞬」 */
  window.requestAnimationFrame(function () {
    var hero = document.querySelectorAll(".pomo__title, .pomo__eyebrow, .pomo__lead");
    for (var i = 0; i < hero.length; i++) hero[i].classList.add("is-in");
  });

  /* ------------------------------------------------------------------ *
   * 3. 阅读进度线
   * ------------------------------------------------------------------ */
  var progress = document.getElementById("progress");
  var ticking = false;

  var update = function () {
    if (progress) {
      var max = document.documentElement.scrollHeight - window.innerHeight;
      var ratio = max > 0 ? Math.min(window.scrollY / max, 1) : 0;
      progress.style.setProperty("--p", String(ratio));
    }
    ticking = false;
  };

  window.addEventListener(
    "scroll",
    function () {
      if (!ticking) {
        ticking = true;
        window.requestAnimationFrame(update);
      }
    },
    { passive: true }
  );
  update();

  /* ------------------------------------------------------------------ *
   * 4. 移动端抽屉
   * ------------------------------------------------------------------ */
  var toggle = document.querySelector(".header__toggle");
  var nav = document.getElementById("site-nav");

  if (toggle && nav) {
    var setOpen = function (open) {
      nav.classList.toggle("is-open", open);
      toggle.setAttribute("aria-expanded", String(open));
      toggle.setAttribute("aria-label", open ? "关闭菜单" : "打开菜单");
    };

    toggle.addEventListener("click", function () {
      setOpen(!nav.classList.contains("is-open"));
    });

    // 点导航项后收起
    nav.addEventListener("click", function (e) {
      if (e.target.closest("a") && nav.classList.contains("is-open")) setOpen(false);
    });

    // Escape 收起并把焦点还给按钮（键盘用户不然会迷失焦点）
    document.addEventListener("keydown", function (e) {
      if (e.key === "Escape" && nav.classList.contains("is-open")) {
        setOpen(false);
        toggle.focus();
      }
    });
  }
})();
