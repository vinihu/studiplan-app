/* The interactive demo on the landing page: the app's screens, re-created in HTML, with the
   real flow wired up. Nothing is generated here. The summary, the flashcards and the quiz are
   results the app itself made with Claude Code; this script only shows them.

   No dependencies, no network, no innerHTML: every text is set with textContent. Without this
   script the page still shows the material screen as plain HTML. */
(function () {
  "use strict";

  var SVG = "http://www.w3.org/2000/svg";
  var reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)");

  /* ── What the app made (shortened: see the notes shown in the demo) ───────────────────── */

  var CARDS = [
    { front: "What are the two main parts of the cell cycle?", back: "Interphase and the M phase." },
    { front: "What happens in the G1 phase?", back: "The cell grows and makes proteins and organelles." },
    { front: "What happens in the S phase?", back: "The DNA is replicated. Each chromosome then consists of two sister chromatids joined at the centromere." },
    { front: "What does the M phase consist of?", back: "Mitosis (division of the nucleus) and cytokinesis (division of the cytoplasm)." },
    { front: "Why is a very large cell a problem for exchange of materials?", back: "Its volume grows faster than its surface area, so exchange across the membrane becomes too slow." },
    { front: "What are the four phases of mitosis, in order?", back: "Prophase, metaphase, anaphase, telophase." }
  ];

  var QUESTIONS = [
    {
      prompt: "Which stage of interphase is the one in which each chromosome comes to consist of two sister chromatids?",
      options: ["S phase", "G1 phase", "G2 phase", "Prophase"],
      answer: 0,
      why: "DNA is replicated in S phase, so each chromosome then has two sister chromatids joined at the centromere. G1 is growth and G2 is preparation for division; prophase belongs to mitosis, not interphase."
    },
    {
      prompt: "A cell becomes very large. Why does this cause a problem?",
      options: [
        "Its volume grows faster than its surface area, so exchange across the membrane becomes too slow",
        "Its surface area grows faster than its volume, so too many materials enter at once",
        "Its DNA can no longer be replicated during S phase",
        "Its nuclear envelope can no longer break down in prophase"
      ],
      answer: 0,
      why: "Volume increases faster than surface area, so the membrane cannot exchange materials fast enough. This is one reason cells divide. The other options describe things the material does not link to cell size."
    },
    {
      prompt: "What is the difference between mitosis and cytokinesis?",
      options: [
        "Mitosis divides the cytoplasm, cytokinesis divides the nucleus",
        "Mitosis divides the nucleus, cytokinesis divides the cytoplasm",
        "Mitosis copies the DNA, cytokinesis checks the DNA",
        "Mitosis is part of interphase, cytokinesis is part of the M phase"
      ],
      answer: 1,
      why: "Mitosis is division of the nucleus and cytokinesis is division of the cytoplasm; together they make up the M phase."
    }
  ];

  /* The Make section's words, as in the app (src/renderer/src/lib/make.ts). */
  var KINDS = {
    summary: { action: "Make summary", sentence: "a summary", sizeLabel: "Length", sizes: ["Short", "Medium", "Long"], hint: "The material in short, to read before you practise.", title: "Summary: Cell division", row: "Summary" },
    flashcards: { action: "Make flashcards", sentence: "flashcards", sizeLabel: "Size", sizes: ["10 cards", "20 cards", "40 cards"], hint: "Cards with a question on the front and the answer on the back.", title: "Flashcards: Cell division", row: "Flashcards" },
    quiz: { action: "Make quiz", sentence: "a quiz", sizeLabel: "Size", sizes: ["5 questions", "10 questions", "20 questions"], hint: "A quick check, mostly multiple choice, with explanations.", title: "Quiz: Cell division", row: "Quiz" },
    exam: { action: "Make mock exam", sentence: "a mock exam", sizeLabel: "Size", sizes: ["10 questions", "20 questions", "30 questions"], hint: "A longer paper with written questions and points, like the real thing.", missing: "This demo has no saved mock exam to show, so there is nothing to make here." },
    custom: { action: "Make it", sentence: "what you asked for", sizeLabel: "", sizes: [], hint: "Anything else from this material: a timeline, a list of formulas, an explanation of one part.", missing: "This demo cannot make something new: nothing runs in your browser." }
  };
  var KIND_ICONS = { summary: "summary", flashcards: "layers", quiz: "quiz", exam: "exam", custom: "pen" };
  var STEPS = ["Reading the files…", "Asking Claude Code…", "Checking the answer…", "Saving…"];
  var STEP_MS = 700;

  /* ── Small helpers ─────────────────────────────────────────────────────────────────────── */

  function el(tag, className, text) {
    var node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined && text !== null) node.textContent = text;
    return node;
  }

  function icon(name) {
    var svg = document.createElementNS(SVG, "svg");
    svg.setAttribute("class", "sp-icon");
    svg.setAttribute("aria-hidden", "true");
    svg.setAttribute("focusable", "false");
    var use = document.createElementNS(SVG, "use");
    use.setAttribute("href", "#sp-" + name);
    svg.appendChild(use);
    return svg;
  }

  function button(className, label, iconName) {
    var node = el("button", className);
    node.type = "button";
    if (iconName) node.appendChild(icon(iconName));
    node.appendChild(document.createTextNode(label));
    return node;
  }

  function clear(node) {
    while (node.firstChild) node.removeChild(node.firstChild);
  }

  function plural(count, word) {
    return count + " " + word + (count === 1 ? "" : "s");
  }

  function shuffled(list) {
    var copy = list.slice();
    for (var i = copy.length - 1; i > 0; i--) {
      var j = Math.floor(Math.random() * (i + 1));
      var held = copy[i];
      copy[i] = copy[j];
      copy[j] = held;
    }
    return copy;
  }

  var MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

  /** "3 Oct 2026", the way the app writes a day. */
  function dayOf(date) {
    return date.getDate() + " " + MONTHS[date.getMonth()] + " " + date.getFullYear();
  }

  function timeOf(date) {
    return String(date.getHours()).padStart(2, "0") + ":" + String(date.getMinutes()).padStart(2, "0");
  }

  /** As in the app: a date says its time only when another row was made on the same day. */
  function writeDates(list) {
    var cells = Array.prototype.slice.call(list.querySelectorAll("[data-day]"));
    cells.forEach(function (cell) {
      var day = cell.getAttribute("data-day");
      var shared = cells.filter(function (other) { return other.getAttribute("data-day") === day; }).length > 1;
      cell.textContent = shared ? day + ", " + cell.getAttribute("data-time") : day;
    });
  }

  /* ── Make: the kinds, the sizes, and (in the full demo) the making itself ───────────────── */

  function setUpMake(root, hooks) {
    var full = root.getAttribute("data-sp-make") === "full";
    var kindButtons = Array.prototype.slice.call(root.querySelectorAll("[data-kind]"));
    var hint = root.querySelector("[data-sp-hint]");
    var sizeRow = root.querySelector("[data-sp-size]");
    var sizeLabel = root.querySelector("[data-sp-size-label]");
    var sizes = root.querySelector("[data-sp-sizes]");
    var request = root.querySelector("[data-sp-request]");
    var controls = root.querySelector("[data-sp-controls]");
    var go = root.querySelector("[data-sp-go]");
    var withLine = root.querySelector("[data-sp-with]");
    var progress = root.querySelector("[data-sp-progress]");
    var outcome = root.querySelector("[data-sp-outcome]");
    var state = { kind: "summary", sizes: {}, running: false, timers: [] };

    function chosenSize(kind) {
      return state.sizes[kind] !== undefined ? state.sizes[kind] : 1;
    }

    function render() {
      var kind = KINDS[state.kind];
      kindButtons.forEach(function (item) {
        item.setAttribute("aria-pressed", String(item.getAttribute("data-kind") === state.kind));
        item.disabled = state.running;
      });
      hint.textContent = kind.hint;
      sizeRow.hidden = kind.sizes.length === 0;
      sizeLabel.textContent = kind.sizeLabel;
      clear(sizes);
      kind.sizes.forEach(function (label, index) {
        var choice = button("sp-toggle", label);
        choice.setAttribute("aria-pressed", String(index === chosenSize(state.kind)));
        choice.addEventListener("click", function () {
          state.sizes[state.kind] = index;
          render();
          sizes.children[index].focus();
        });
        sizes.appendChild(choice);
      });
      if (request) request.hidden = state.kind !== "custom";
      if (full) {
        go.textContent = kind.action;
        go.disabled = Boolean(kind.missing);
        withLine.textContent = kind.missing || "With Claude Code (sonnet). Your files are sent to it when you press the button.";
        withLine.className = kind.missing ? "sp-with sp-demo-note" : "sp-with";
        controls.hidden = state.running;
        progress.hidden = !state.running;
      }
    }

    kindButtons.forEach(function (item) {
      item.addEventListener("click", function () {
        state.kind = item.getAttribute("data-kind");
        render();
      });
    });

    function notice(title, withOpen) {
      clear(outcome);
      var box = el("div", "sp-notice");
      box.setAttribute("role", "status");
      box.appendChild(icon("info"));
      box.appendChild(el("p", "sp-notice-title", title));
      var actions = el("div", "sp-notice-actions");
      var first = null;
      if (withOpen) {
        first = button("sp-button sp-button--small", "Open");
        first.addEventListener("click", function () { hooks.open(withOpen); });
        actions.appendChild(first);
      }
      var close = el("button", "sp-icon-button");
      close.type = "button";
      close.setAttribute("aria-label", "Close this message");
      close.appendChild(icon("x"));
      close.addEventListener("click", function () {
        clear(outcome);
        hooks.dismissed();
        go.focus();
      });
      actions.appendChild(close);
      box.appendChild(actions);
      outcome.appendChild(box);
      (first || close).focus({ preventScroll: true });
    }

    function stop() {
      state.timers.forEach(window.clearTimeout);
      state.timers = [];
      state.running = false;
      render();
    }

    function finish(kindId) {
      stop();
      hooks.made(kindId, KINDS[kindId].sizes[chosenSize(kindId)]);
      notice("“" + KINDS[kindId].title + "” is saved in Results", kindId);
    }

    function start() {
      var kindId = state.kind;
      if (KINDS[kindId].missing || state.running) return;
      clear(outcome);
      hooks.dismissed();
      if (reducedMotion.matches) {
        finish(kindId);
        return;
      }
      state.running = true;
      render();
      progress.querySelector("[data-sp-progress-title]").textContent = "Making " + KINDS[kindId].sentence;
      var message = progress.querySelector("[data-sp-progress-message]");
      message.textContent = "Starting…";
      STEPS.forEach(function (text, index) {
        state.timers.push(window.setTimeout(function () { message.textContent = text; }, 150 + index * STEP_MS));
      });
      state.timers.push(window.setTimeout(function () { finish(kindId); }, 150 + STEPS.length * STEP_MS));
      progress.querySelector("[data-sp-cancel]").focus({ preventScroll: true });
    }

    if (full) {
      go.addEventListener("click", start);
      progress.querySelector("[data-sp-cancel]").addEventListener("click", function () {
        stop();
        notice("Cancelled. Nothing was saved.", null);
      });
    }
    render();
  }

  /* ── Flashcards ────────────────────────────────────────────────────────────────────────── */

  function setUpCards(root) {
    var state;

    function fresh(order, pass, isShuffled) {
      state = { order: order, position: 0, flipped: false, marks: {}, pass: pass, shuffled: isShuffled, finished: false };
    }

    function all() {
      return CARDS.map(function (_, index) { return index; });
    }

    function missed() {
      return state.order.filter(function (card) { return state.marks[card] !== "got"; });
    }

    function act(action) {
      if (action === "flip") state.flipped = !state.flipped;
      else if (action === "next") {
        if (state.position === state.order.length - 1) state.finished = true;
        else { state.position += 1; state.flipped = false; }
      } else if (action === "previous") {
        if (state.position > 0) { state.position -= 1; state.flipped = false; }
      } else if (action === "again" || action === "got") {
        state.marks[state.order[state.position]] = action;
        act("next");
        return;
      }
      render(true);
    }

    function render(takeFocus) {
      clear(root);
      if (state.finished) {
        var got = state.order.filter(function (card) { return state.marks[card] === "got"; }).length;
        var again = state.order.filter(function (card) { return state.marks[card] === "again"; }).length;
        var skipped = state.order.length - got - again;
        var left = missed().length;
        var round = el("div", "sp-round");
        var heading = el("h4", null, "You got " + got + " of " + state.order.length);
        heading.tabIndex = -1;
        round.appendChild(heading);
        var details = [];
        if (again > 0) details.push(again + " to go again");
        if (skipped > 0) details.push(skipped + " skipped");
        var line = el("p", null, left === 0 ? (state.pass > 1 ? "That was the last of the ones you missed." : "Every card in the deck.") : details.join(", ") + ".");
        line.setAttribute("role", "status");
        round.appendChild(line);
        var actions = el("div", "sp-round-actions");
        if (left > 0) {
          var redo = button("sp-button sp-button--primary", "Redo the " + (left === 1 ? "one" : left) + " you missed");
          redo.addEventListener("click", function () {
            var order = missed();
            fresh(state.shuffled ? shuffled(order) : order, state.pass + 1, state.shuffled);
            render(true);
          });
          actions.appendChild(redo);
        }
        var over = button(left > 0 ? "sp-button" : "sp-button sp-button--primary", "Start over with all " + plural(CARDS.length, "card"), "rotate");
        over.addEventListener("click", function () {
          fresh(state.shuffled ? shuffled(all()) : all(), 1, state.shuffled);
          render(true);
        });
        actions.appendChild(over);
        round.appendChild(actions);
        root.appendChild(round);
        if (takeFocus) heading.focus({ preventScroll: true });
        return;
      }

      var card = CARDS[state.order[state.position]];
      var total = state.order.length;
      var mark = state.marks[state.order[state.position]];

      var top = el("div", "sp-cards-head");
      var row = el("div", "sp-cards-top");
      var count = el("p", "sp-cards-count");
      count.appendChild(el("b", null, "Card " + (state.position + 1) + " of " + total));
      if (state.pass > 1) count.appendChild(el("span", null, " · the ones you missed"));
      row.appendChild(count);
      var shuffle = button("sp-ghost-toggle", "Shuffle", "shuffle");
      shuffle.setAttribute("aria-pressed", String(state.shuffled));
      shuffle.addEventListener("click", function () {
        var on = !state.shuffled;
        var order = state.order.slice().sort(function (a, b) { return a - b; });
        var pass = state.pass;
        fresh(on ? shuffled(order) : order, pass, on);
        render(false);
        root.querySelector(".sp-ghost-toggle").focus({ preventScroll: true });
      });
      row.appendChild(shuffle);
      top.appendChild(row);
      var meter = el("div", "sp-meter");
      meter.setAttribute("role", "progressbar");
      meter.setAttribute("aria-label", "Cards done in this round");
      meter.setAttribute("aria-valuemin", "0");
      meter.setAttribute("aria-valuemax", String(total));
      meter.setAttribute("aria-valuenow", String(state.position));
      var fill = el("i");
      fill.style.width = (state.position / total) * 100 + "%";
      meter.appendChild(fill);
      top.appendChild(meter);
      root.appendChild(top);

      var face = el("div", "sp-face");
      face.setAttribute("role", "button");
      face.tabIndex = 0;
      face.setAttribute("aria-keyshortcuts", "Space");
      var faceTop = el("div", "sp-face-top");
      faceTop.appendChild(el("span", null, state.flipped ? "Answer" : "Question"));
      if (mark) faceTop.appendChild(el("span", null, "Marked " + (mark === "got" ? "got it" : "again")));
      face.appendChild(faceTop);
      face.appendChild(el("div", state.flipped ? "sp-face-text" : "sp-face-text sp-face-text--front", state.flipped ? card.back : card.front));
      face.addEventListener("click", function () {
        if (String(window.getSelection()) !== "") return;
        act("flip");
      });
      root.appendChild(face);
      var said = el("p", "visually-hidden", (state.flipped ? "Answer: " + card.back : "Question: " + card.front));
      said.setAttribute("role", "status");
      root.appendChild(said);

      var bar = el("div", "sp-cards-bar");
      var previous = el("button", "sp-icon-button");
      previous.type = "button";
      previous.setAttribute("aria-label", "Previous card");
      previous.disabled = state.position === 0;
      previous.appendChild(icon("left"));
      previous.addEventListener("click", function () { act("previous"); });
      bar.appendChild(previous);
      var marks = el("div", "sp-cards-marks");
      if (state.flipped) {
        var againButton = button("sp-button", "Again", "rotate");
        againButton.addEventListener("click", function () { act("again"); });
        var gotButton = button("sp-button", "Got it", "check");
        gotButton.addEventListener("click", function () { act("got"); });
        marks.appendChild(againButton);
        marks.appendChild(gotButton);
      } else {
        var show = button("sp-button sp-button--primary", "Show answer");
        show.addEventListener("click", function () { act("flip"); });
        marks.appendChild(show);
      }
      bar.appendChild(marks);
      var next = el("button", "sp-icon-button");
      next.type = "button";
      next.setAttribute("aria-label", state.position === total - 1 ? "Finish the round" : "Next card");
      next.appendChild(icon("right"));
      next.addEventListener("click", function () { act("next"); });
      bar.appendChild(next);
      root.appendChild(bar);

      var keys = el("p", "sp-keys");
      [[["Space"], "flip"], [["←", "→"], "move"], [["1"], "again"], [["2"], "got it"]].forEach(function (pair) {
        var group = el("span");
        pair[0].forEach(function (key) { group.appendChild(el("kbd", null, key)); });
        group.appendChild(document.createTextNode(pair[1]));
        keys.appendChild(group);
      });
      root.appendChild(keys);

      if (takeFocus) face.focus({ preventScroll: true });
    }

    /* Only keys pressed inside the player; the rest of the page keeps its own. */
    root.addEventListener("keydown", function (event) {
      if (state.finished || event.defaultPrevented || event.altKey || event.ctrlKey || event.metaKey) return;
      var onControl = event.target.closest("button") !== null;
      if ((event.key === " " || event.key === "Enter") && !onControl) act("flip");
      else if (event.key === "ArrowRight") act("next");
      else if (event.key === "ArrowLeft") act("previous");
      else if (event.key === "1" && state.flipped) act("again");
      else if (event.key === "2" && state.flipped) act("got");
      else return;
      event.preventDefault();
    });

    return {
      open: function () {
        fresh(all(), 1, false);
        render(false);
      }
    };
  }

  /* ── Quiz ──────────────────────────────────────────────────────────────────────────────── */

  var quizCount = 0;

  function chip(correct) {
    var node = el("span", "sp-chip " + (correct === null ? "sp-chip--none" : correct ? "sp-chip--correct" : "sp-chip--wrong"));
    if (correct !== null) node.appendChild(icon(correct ? "check" : "x"));
    node.appendChild(document.createTextNode(correct === null ? "Not answered · 0 / 1" : correct ? "Correct · 1 / 1" : "Wrong · 0 / 1"));
    return node;
  }

  /** One question after submitting: the options marked, and why. `order` is the order shown. */
  function reviewedQuestion(question, index, order, picked) {
    var item = el("li", "sp-question");
    var head = el("div");
    var top = el("div", "sp-question-top");
    top.appendChild(el("p", "sp-question-number", "Question " + (index + 1) + " · 1 point"));
    top.appendChild(chip(picked === null ? null : picked === question.answer));
    head.appendChild(top);
    head.appendChild(el("h4", "sp-prompt", question.prompt));
    item.appendChild(head);
    var list = el("ul", "sp-options");
    order.forEach(function (option) {
      var correct = option === question.answer;
      var isPicked = option === picked;
      var row = el("li", "sp-option " + (correct ? "sp-option--correct" : isPicked ? "sp-option--picked" : "sp-option--plain"));
      var mark = el("span", "sp-option-mark");
      mark.setAttribute("aria-hidden", "true");
      mark.appendChild(correct ? icon("check") : isPicked ? icon("x") : el("i"));
      row.appendChild(mark);
      row.appendChild(el("span", "sp-option-text", question.options[option]));
      var note = correct ? (isPicked ? "Your answer, correct" : "Correct answer") : isPicked ? "Your answer" : null;
      if (note) row.appendChild(el("span", "sp-option-note", note));
      list.appendChild(row);
    });
    item.appendChild(list);
    var why = el("div", "sp-why");
    why.appendChild(el("h5", null, "Why"));
    why.appendChild(el("p", null, question.why));
    item.appendChild(why);
    return item;
  }

  function setUpQuiz(root) {
    var state;
    var uid = "sp-quiz-" + (quizCount += 1);

    function fresh() {
      state = {
        reviewing: false,
        warned: false,
        orders: QUESTIONS.map(function (question) { return shuffled(question.options.map(function (_, i) { return i; })); }),
        answers: QUESTIONS.map(function () { return null; })
      };
    }

    function missing() {
      return state.answers.filter(function (answer) { return answer === null; }).length;
    }

    function retakeButton() {
      var retake = button("sp-button", "Retake", "rotate");
      retake.addEventListener("click", function () {
        fresh();
        render(true);
      });
      return retake;
    }

    function renderFooter(footer) {
      clear(footer);
      var left = missing();
      var line = el("p");
      if (state.warned && left > 0) {
        line.setAttribute("role", "alert");
        line.appendChild(el("b", null, (left === 1 ? "1 question is" : left + " questions are") + " not answered"));
        line.appendChild(document.createTextNode(" and will earn no points."));
      } else {
        line.textContent = QUESTIONS.length - left + " of " + QUESTIONS.length + " answered";
      }
      footer.appendChild(line);
      var submit = button("sp-button sp-button--primary", state.warned && left > 0 ? "Submit anyway" : "Submit");
      submit.addEventListener("click", function () {
        if (missing() > 0 && !state.warned) {
          state.warned = true;
          renderFooter(footer);
          footer.querySelector("button").focus({ preventScroll: true });
          return;
        }
        state.reviewing = true;
        render(true);
      });
      footer.appendChild(submit);
    }

    function render(takeFocus) {
      clear(root);
      if (state.reviewing) {
        var earned = QUESTIONS.filter(function (question, index) { return state.answers[index] === question.answer; }).length;
        var score = el("div", "sp-score");
        score.tabIndex = -1;
        var words = el("div");
        words.setAttribute("role", "status");
        words.appendChild(el("h4", null, "Your score"));
        var points = el("p", "sp-score-points");
        points.appendChild(el("b", null, earned + " / " + QUESTIONS.length));
        points.appendChild(document.createTextNode("points · " + Math.round((earned / QUESTIONS.length) * 100) + "%"));
        words.appendChild(points);
        words.appendChild(el("p", "sp-score-line", earned + " of " + plural(QUESTIONS.length, "question") + " fully right."));
        score.appendChild(words);
        score.appendChild(retakeButton());
        root.appendChild(score);
        var reviewed = el("ol", "sp-questions sp-questions--ruled");
        QUESTIONS.forEach(function (question, index) {
          reviewed.appendChild(reviewedQuestion(question, index, state.orders[index], state.answers[index]));
        });
        root.appendChild(reviewed);
        var bottom = el("div", "sp-retake");
        bottom.appendChild(retakeButton());
        root.appendChild(bottom);
        if (takeFocus) score.focus({ preventScroll: true });
        return;
      }

      var list = el("ol", "sp-questions");
      var footer = el("div", "sp-submit");
      QUESTIONS.forEach(function (question, index) {
        var item = el("li", "sp-question");
        var head = el("div");
        var top = el("div", "sp-question-top");
        top.appendChild(el("p", "sp-question-number", "Question " + (index + 1) + " · 1 point"));
        head.appendChild(top);
        var prompt = el("h4", "sp-prompt", question.prompt);
        prompt.id = uid + "-q" + index;
        head.appendChild(prompt);
        item.appendChild(head);
        var group = el("div", "sp-options");
        group.setAttribute("role", "radiogroup");
        group.setAttribute("aria-labelledby", prompt.id);
        state.orders[index].forEach(function (option) {
          var label = el("label", "sp-option");
          var input = el("input");
          input.type = "radio";
          input.name = uid + "-q" + index;
          input.addEventListener("change", function () {
            state.answers[index] = option;
            renderFooter(footer);
          });
          label.appendChild(input);
          label.appendChild(el("span", "sp-option-text", question.options[option]));
          group.appendChild(label);
        });
        item.appendChild(group);
        list.appendChild(item);
      });
      root.appendChild(list);
      renderFooter(footer);
      root.appendChild(footer);
      if (takeFocus) {
        var first = root.querySelector("input");
        if (first) first.focus({ preventScroll: true });
      }
    }

    return {
      open: function () {
        fresh();
        render(false);
      }
    };
  }

  /* ── The whole demo: which screen is showing ────────────────────────────────────────────── */

  function setUpDemo(demo) {
    var views = Array.prototype.slice.call(demo.querySelectorAll("[data-sp-view]"));
    var results = demo.querySelector("[data-sp-results]");
    var resultCount = demo.querySelector("[data-sp-result-count]");
    var cards = setUpCards(demo.querySelector("[data-sp-cards]"));
    var quiz = setUpQuiz(demo.querySelector("[data-sp-quiz]"));

    function show(name, subject) {
      views.forEach(function (view) { view.hidden = view.getAttribute("data-sp-view") !== name; });
      if (name === "library") {
        Array.prototype.forEach.call(demo.querySelectorAll("[data-sp-library]"), function (list) {
          list.hidden = list.getAttribute("data-sp-library") !== subject;
        });
      }
      if (subject) {
        Array.prototype.forEach.call(demo.querySelectorAll("[data-sp-subject]"), function (item) {
          if (item.getAttribute("data-sp-subject") === subject) item.setAttribute("aria-current", "page");
          else item.removeAttribute("aria-current");
        });
      }
      var current = demo.querySelector('[data-sp-view="' + name + '"]');
      var heading = name === "library" ? current.querySelector('[data-sp-library="' + subject + '"] .sp-title') : current.querySelector(".sp-title");
      if (heading) heading.focus({ preventScroll: true });
      /* A long screen was open: bring the top of the demo back into view, as the app does. */
      var box = demo.getBoundingClientRect();
      if (box.top < 0) demo.scrollIntoView({ block: "start" });
    }

    function open(kind) {
      if (kind === "flashcards") cards.open();
      if (kind === "quiz") quiz.open();
      show(kind);
    }

    function countResults() {
      resultCount.textContent = plural(results.children.length, "result");
    }

    demo.addEventListener("click", function (event) {
      var target = event.target.closest("[data-sp-open], [data-sp-back], [data-sp-subject], [data-sp-material]");
      if (!target || !demo.contains(target)) return;
      if (target.hasAttribute("data-sp-open")) open(target.getAttribute("data-sp-open"));
      else if (target.hasAttribute("data-sp-back")) show(target.getAttribute("data-sp-back"), "Biology");
      else if (target.hasAttribute("data-sp-subject")) show("library", target.getAttribute("data-sp-subject"));
      else if (target.hasAttribute("data-sp-material")) show("material", "Biology");
    });

    setUpMake(demo.querySelector("[data-sp-make]"), {
      open: open,
      dismissed: function () {
        Array.prototype.forEach.call(results.querySelectorAll(".sp-new"), function (mark) { mark.remove(); });
      },
      made: function (kind, size) {
        var item = el("li");
        var row = el("button", "sp-row sp-row--result");
        row.type = "button";
        row.setAttribute("data-sp-open", kind);
        var name = el("span", "sp-cell-name");
        name.appendChild(icon(KIND_ICONS[kind]));
        var title = el("span", "sp-name", KINDS[kind].title);
        title.appendChild(el("span", "sp-new", "New"));
        name.appendChild(title);
        row.appendChild(name);
        /* The row says what was asked for. What opens is the one saved result, and its screen says so. */
        row.appendChild(el("span", "sp-fact", KINDS[kind].row + " \u00b7 " + size));
        row.appendChild(el("span", "sp-fact sp-maker", "Claude Code · sonnet"));
        var now = new Date();
        var date = el("span", "sp-fact sp-end sp-date");
        date.setAttribute("data-day", dayOf(now));
        date.setAttribute("data-time", timeOf(now));
        row.appendChild(date);
        item.appendChild(row);
        results.insertBefore(item, results.firstChild);
        writeDates(results);
        countResults();
      }
    });
  }

  /* ── The pieces shown on their own further down the page ────────────────────────────────── */

  function setUpFlip(root) {
    var face = root.querySelector(".sp-face");
    var label = root.querySelector("[data-sp-side]");
    var text = root.querySelector("[data-sp-text]");
    var flipped = false;
    function flip() {
      flipped = !flipped;
      label.textContent = flipped ? "Answer" : "Question";
      text.textContent = flipped ? CARDS[0].back : CARDS[0].front;
      text.className = flipped ? "sp-face-text" : "sp-face-text sp-face-text--front";
    }
    face.setAttribute("role", "button");
    face.tabIndex = 0;
    face.addEventListener("click", flip);
    face.addEventListener("keydown", function (event) {
      if (event.key !== " " && event.key !== "Enter") return;
      event.preventDefault();
      flip();
    });
  }

  /* ── The pill in the headline ───────────────────────────────────────────────────────────── */

  /* One word at a time. The widths are measured once the font is there and again when the window
     changes size, never per frame. A change is laid out at once and then played back with
     transforms (FLIP): no layout happens while it moves, so the motion is even at any pixel density. */
  function setUpPill(pill) {
    var HOLD_MS = 1900;
    var MOVE_MS = 520;
    var EASE = "cubic-bezier(0.22, 1, 0.36, 1)";
    var words = Array.prototype.slice.call(pill.children);
    var row = pill.closest(".keep");
    var into = row ? row.querySelector(".into") : null;
    var widths = [];
    var current = 0;
    var timer = null;
    var playing = [];

    function measure() {
      playing.forEach(function (animation) { animation.cancel(); });
      playing = [];
      pill.style.removeProperty("--pill-width");
      pill.style.removeProperty("--pill-max");
      /* Whole pixels, and a row that leaves an even number of pixels beside it: at rest the row
         then sits on whole pixels and its text is as sharp as the rest. */
      widths = words.map(function (word) { return Math.ceil(word.getBoundingClientRect().width); });
      if (row && into) {
        var style = window.getComputedStyle(pill);
        var fixed = into.getBoundingClientRect().width + parseFloat(window.getComputedStyle(row).columnGap || "0") + parseFloat(style.paddingLeft) + parseFloat(style.paddingRight);
        var room = row.getBoundingClientRect().width;
        widths = widths.map(function (width) {
          var free = room - fixed - width;
          return width + (free - 2 * Math.floor(free / 2));
        });
      }
      pill.style.setProperty("--pill-max", Math.max.apply(null, widths) + "px");
      pill.style.setProperty("--pill-width", widths[current] + "px");
    }

    function glide(node, frames) {
      if (!node || !node.animate) return;
      var animation = node.animate(frames, { duration: MOVE_MS, easing: EASE });
      playing.push(animation);
      animation.onfinish = animation.oncancel = function () {
        playing = playing.filter(function (other) { return other !== animation; });
      };
    }

    function step() {
      var leaving = words[current];
      var from = widths[current];
      current = (current + 1) % words.length;
      var arriving = words[current];
      var grow = widths[current] - from;
      var shift = grow / 2;

      /* The new layout, at once: the row is centred for the new word. */
      pill.style.setProperty("--pill-width", widths[current] + "px");
      /* And the way there: both start where they were and glide to where they now are, while the
         pill's right edge goes from the old width to the new one. */
      glide(into, [{ transform: "translateX(" + shift + "px)" }, { transform: "translateX(0)" }]);
      glide(pill, [
        { transform: "translateX(" + shift + "px)", clipPath: "inset(0 " + grow + "px 0 0 round 999px)" },
        { transform: "translateX(0)", clipPath: "inset(0 0px 0 0 round 999px)" }
      ]);

      leaving.classList.remove("is-in");
      leaving.classList.add("is-out");
      arriving.classList.remove("is-waiting");
      arriving.classList.add("is-in");
      window.setTimeout(function () {
        if (leaving.classList.contains("is-in")) return;
        leaving.classList.add("is-waiting");
        leaving.classList.remove("is-out");
      }, MOVE_MS + 80);
      timer = window.setTimeout(step, HOLD_MS + MOVE_MS);
    }

    function play() {
      if (timer === null && !document.hidden && !reducedMotion.matches) timer = window.setTimeout(step, HOLD_MS);
    }

    function pause() {
      window.clearTimeout(timer);
      timer = null;
    }

    function start() {
      pill.classList.add("rotator--live");
      words.forEach(function (word, index) { word.classList.add(index === 0 ? "is-in" : "is-waiting"); });
      measure();
      play();
      var resizing = null;
      window.addEventListener("resize", function () {
        if (resizing !== null) return;
        resizing = window.requestAnimationFrame(function () { resizing = null; measure(); });
      });
      /* A hidden tab stops timers unevenly: stop on purpose, and start again from a held word. */
      document.addEventListener("visibilitychange", function () { if (document.hidden) pause(); else play(); });
    }

    if (reducedMotion.matches) return;
    (document.fonts && document.fonts.ready ? document.fonts.ready : Promise.resolve()).then(start);
  }

  Array.prototype.forEach.call(document.querySelectorAll(".rotator"), setUpPill);
  Array.prototype.forEach.call(document.querySelectorAll("[data-sp-demo]"), setUpDemo);
  Array.prototype.forEach.call(document.querySelectorAll('[data-sp-make="lite"]'), function (root) { setUpMake(root, null); });
  Array.prototype.forEach.call(document.querySelectorAll("[data-sp-flip]"), setUpFlip);

  /* ── Windows or Mac: the menu on the download button ─────────────────────────────────────── */

  /* Windows is what shows first on every device; nothing is detected. Choosing only makes one
     button and one note visible and the others invisible, so nothing on the page moves. */
  Array.prototype.forEach.call(document.querySelectorAll("[data-platform]"), function (root) {
    var split = root.querySelector(".split");
    var toggle = root.querySelector("[data-platform-toggle]");
    var menu = root.querySelector("[data-platform-menu]");
    var items = Array.prototype.slice.call(menu.querySelectorAll("[data-platform-pick]"));

    function isOpen() {
      return !menu.hidden;
    }

    function open(focusIndex) {
      menu.hidden = false;
      toggle.setAttribute("aria-expanded", "true");
      var checked = items.filter(function (item) { return item.getAttribute("aria-checked") === "true"; })[0];
      (focusIndex === undefined ? checked || items[0] : items[focusIndex]).focus({ preventScroll: true });
    }

    function close(returnFocus) {
      if (!isOpen()) return;
      menu.hidden = true;
      toggle.setAttribute("aria-expanded", "false");
      if (returnFocus) toggle.focus({ preventScroll: true });
    }

    function choose(item) {
      var chosen = item.getAttribute("data-platform-pick");
      items.forEach(function (other) { other.setAttribute("aria-checked", String(other === item)); });
      Array.prototype.forEach.call(root.querySelectorAll("[data-platform-show]"), function (shown) {
        shown.classList.toggle("is-off", shown.getAttribute("data-platform-show") !== chosen);
      });
      split.setAttribute("data-chosen", chosen);
      close(true);
    }

    toggle.addEventListener("click", function () {
      if (isOpen()) close(true); else open();
    });
    toggle.addEventListener("keydown", function (event) {
      if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
      event.preventDefault();
      open(event.key === "ArrowUp" ? items.length - 1 : undefined);
    });
    items.forEach(function (item, index) {
      item.addEventListener("click", function () { choose(item); });
      item.addEventListener("keydown", function (event) {
        var to = null;
        if (event.key === "ArrowDown") to = (index + 1) % items.length;
        else if (event.key === "ArrowUp") to = (index - 1 + items.length) % items.length;
        else if (event.key === "Home") to = 0;
        else if (event.key === "End") to = items.length - 1;
        else if (event.key === "Escape") { event.preventDefault(); close(true); return; }
        else if (event.key === "Tab") { close(false); return; }
        else return;
        event.preventDefault();
        items[to].focus({ preventScroll: true });
      });
    });
    /* A click or a tap anywhere else, or focus going elsewhere, closes it. */
    document.addEventListener("pointerdown", function (event) {
      if (isOpen() && !split.contains(event.target)) close(false);
    });
    split.addEventListener("focusout", function (event) {
      if (isOpen() && event.relatedTarget && !split.contains(event.relatedTarget)) close(false);
    });

    split.classList.add("split--live");
    split.setAttribute("data-chosen", "windows");
    toggle.hidden = false;
  });

  document.documentElement.classList.add("sp-js");
})();
