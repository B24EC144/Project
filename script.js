"use strict";

const $ = (selector) => document.querySelector(selector);

const fileInput = $("#fileInput");
const uploadButton = $("#uploadButton");
const continueButton = $("#continueButton");
const dropZone = $("#dropZone");

let selectedFile = null;
let currentResult = null;
let currentResultTitle = "";
let currentQuiz = null;
let quizSubmitted = false;

const STORAGE_KEYS = {
    checklist: "ascend_checklist_v2",
    materials: "ascend_materials_v2",
    scores: "ascend_scores_v2"
};

function loadStorage(key, fallback = []) {
    try {
        const value = JSON.parse(localStorage.getItem(key));
        return value ?? fallback;
    } catch {
        return fallback;
    }
}

function saveStorage(key, value) {
    try {
        localStorage.setItem(key, JSON.stringify(value));
    } catch {
        showToolMessage(
            "Browser storage is full. Try removing older saved materials."
        );
    }
}

function setMessage(element, message, isError = true) {
    element.textContent = message;
    element.classList.toggle("success-message", !isError && Boolean(message));
}

function showToolMessage(message, isError = true) {
    setMessage($("#toolMessage"), message, isError);
}

function clearToolMessage() {
    setMessage($("#toolMessage"), "");
}

function showLanding() {
    $("#landingPage").hidden = false;
    $("#workspace").hidden = true;
    $("#toolPanel").hidden = true;
    $("#resultsPanel").hidden = true;
    $("#progressPanel").hidden = true;
    window.scrollTo({ top: 0, behavior: "smooth" });
}

function showWorkspace() {
    $("#landingPage").hidden = true;
    $("#workspace").hidden = false;
    $("#toolPanel").hidden = true;
    $("#resultsPanel").hidden = true;
    $("#progressPanel").hidden = true;

    $("#workspaceFileName").textContent =
        selectedFile ? selectedFile.name : "No file selected";

    window.scrollTo({ top: 0, behavior: "smooth" });
}

function updateSelectedFile(file) {
    const message = $("#message");

    if (!file) return;

    const allowedExtensions = [
        ".txt", ".pdf", ".png", ".jpg", ".jpeg", ".webp"
    ];

    const extension = "." + file.name.split(".").pop().toLowerCase();

    if (!allowedExtensions.includes(extension)) {
        selectedFile = null;
        fileInput.value = "";
        $("#fileDetails").hidden = true;
        continueButton.disabled = true;
        setMessage(message, "Please choose a TXT, PDF, PNG, JPG, JPEG, or WEBP file.");
        return;
    }

    if (file.size > 15 * 1024 * 1024) {
        selectedFile = null;
        fileInput.value = "";
        $("#fileDetails").hidden = true;
        continueButton.disabled = true;
        setMessage(message, "The file is too large. Maximum size is 15 MB.");
        return;
    }

    if (file.size === 0) {
        selectedFile = null;
        continueButton.disabled = true;
        setMessage(message, "This file is empty. Please select another file.");
        return;
    }

    selectedFile = file;
    $("#fileName").textContent = file.name;
    $("#fileDetails").hidden = false;
    continueButton.disabled = false;
    setMessage(message, "File ready! Continue to choose a study tool.", false);
}

uploadButton.addEventListener("click", () => fileInput.click());

fileInput.addEventListener("change", () => {
    updateSelectedFile(fileInput.files[0]);
});

continueButton.addEventListener("click", () => {
    if (!selectedFile) return;
    showWorkspace();
});

$("#backButton").addEventListener("click", showLanding);
$("#homeButton").addEventListener("click", (event) => {
    event.preventDefault();
    showLanding();
});

dropZone.addEventListener("dragover", (event) => {
    event.preventDefault();
    dropZone.classList.add("dragging");
});

dropZone.addEventListener("dragleave", () => {
    dropZone.classList.remove("dragging");
});

dropZone.addEventListener("drop", (event) => {
    event.preventDefault();
    dropZone.classList.remove("dragging");

    const file = event.dataTransfer.files[0];

    if (file) {
        updateSelectedFile(file);
    }
});

// --------------------------------------------------
// Tool selection
// --------------------------------------------------

const toolInformation = {
    syllabus: {
        title: "Syllabus Gap Analysis",
        help: "Compare your uploaded notes with your syllabus.",
        endpoint: "/api/syllabus-gap"
    },
    notes: {
        title: "Revision Notes",
        help: "Create structured revision notes from your file.",
        endpoint: "/api/organize"
    },
    quiz: {
        title: "Practice Quiz",
        help: "Choose your quiz settings and test your understanding.",
        endpoint: "/api/quiz"
    },
    flashcards: {
        title: "Flashcards",
        help: "Generate cards for important terms and concepts.",
        endpoint: "/api/flashcards"
    },
    revision: {
        title: "Quick Revision Sheet",
        help: "Create a concise revision guide.",
        endpoint: "/api/quick-revision"
    }
};

let activeTool = null;

document.querySelectorAll("[data-tool]").forEach((button) => {
    button.addEventListener("click", () => {
        const tool = button.dataset.tool;

        if (tool === "progress") {
            openProgress();
            return;
        }

        openTool(tool);
    });
});

function openTool(tool) {
    activeTool = tool;
    clearToolMessage();

    $("#resultsPanel").hidden = true;
    $("#progressPanel").hidden = true;
    $("#toolPanel").hidden = false;

    $("#toolTitle").textContent = toolInformation[tool].title;
    $("#toolHelp").textContent = toolInformation[tool].help;

    $("#syllabusOptions").hidden = tool !== "syllabus";
    $("#quizOptions").hidden = tool !== "quiz";
    $("#generalOptions").hidden = (
        tool === "syllabus" || tool === "quiz"
    );

    $("#loading").hidden = true;

    $("#runGeneralButton").textContent =
        tool === "notes" ? "Generate Notes" :
        tool === "flashcards" ? "Generate Flashcards" :
        "Generate Quick Revision";

    $("#toolPanel").scrollIntoView({
        behavior: "smooth",
        block: "start"
    });
}

$("#closeToolButton").addEventListener("click", () => {
    $("#toolPanel").hidden = true;
});

document.querySelectorAll("[data-run]").forEach((button) => {
    button.addEventListener("click", () => {
        const tool = button.dataset.run;
        runTool(tool);
    });
});

$("#runGeneralButton").addEventListener("click", () => {
    if (activeTool) runTool(activeTool);
});

// --------------------------------------------------
// Send selected file and options to Flask
// --------------------------------------------------

async function runTool(tool) {
    if (!selectedFile) {
        showToolMessage("Please return home and select your notes file.");
        return;
    }

    const information = toolInformation[tool];

    if (!information) return;

    const formData = new FormData();
    formData.append("file", selectedFile);

    if (tool === "syllabus") {
        let syllabus = $("#syllabusInput").value.trim();
        const syllabusFile = $("#syllabusFile").files[0];

        if (!syllabus && !syllabusFile) {
            showToolMessage("Please paste your syllabus or upload a syllabus file.");
            return;
        }

        if (syllabusFile) {
            const extracted = await readSyllabusFile(syllabusFile);

            if (extracted === null) return;

            syllabus = extracted;
        }

        formData.append("syllabus", syllabus);
    }

    if (tool === "quiz") {
        formData.append("difficulty", $("#difficulty").value);
        formData.append("question_type", $("#questionType").value);
        formData.append("count", $("#questionCount").value);
    }

    $("#loading").hidden = false;
    $("#toolMessage").textContent = "";
    $("#resultsPanel").hidden = true;

    const buttons = $("#toolPanel").querySelectorAll("button");
    buttons.forEach((button) => button.disabled = true);

    try {
        const response = await fetch(information.endpoint, {
            method: "POST",
            body: formData
        });

        const data = await response.json();

        if (!response.ok) {
            throw new Error(data.error || "The request failed.");
        }

        if (tool === "notes") {
            displayTextResult(data.organized_notes, data.title || "Revision Notes");
        } else if (tool === "syllabus") {
            displayTextResult(data.report, data.title || "Syllabus Gap Report");
        } else if (tool === "revision") {
            displayTextResult(data.revision_sheet, data.title || "Quick Revision");
        } else if (tool === "flashcards") {
            displayFlashcards(data.flashcards, data.title || "Flashcards");
        } else if (tool === "quiz") {
            displayQuiz(data.questions, data.title || "Practice Quiz");
        }

    } catch (error) {
        showToolMessage(error.message || "Something went wrong. Please try again.");
    } finally {
        $("#loading").hidden = true;
        buttons.forEach((button) => button.disabled = false);
    }
}

// --------------------------------------------------
// Read an uploaded syllabus file
// --------------------------------------------------

async function readSyllabusFile(file) {
    const extension = "." + file.name.split(".").pop().toLowerCase();

    if (file.size > 15 * 1024 * 1024) {
        showToolMessage("The syllabus file is too large. Maximum size is 15 MB.");
        return null;
    }

    if (extension === ".txt") {
        return await file.text();
    }

    showToolMessage(
        "For this version, please paste the syllabus text into the box. " +
        "The main notes file supports PDF and images through the backend."
    );

    return null;
}

// --------------------------------------------------
// Safe, simple Markdown renderer
// --------------------------------------------------

function escapeHTML(value) {
    return String(value).replace(/[&<>"']/g, (character) => ({
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;",
        "'": "&#39;"
    })[character]);
}

function renderMarkdown(markdown) {
    const lines = String(markdown || "").replace(/\r/g, "").split("\n");
    const output = [];

    let listType = null;
    let paragraph = [];

    function closeList() {
        if (listType) {
            output.push(`</${listType}>`);
            listType = null;
        }
    }

    function flushParagraph() {
        if (paragraph.length) {
            output.push(`<p>${inlineMarkdown(paragraph.join(" "))}</p>`);
            paragraph = [];
        }
    }

    function inlineMarkdown(text) {
        let safe = escapeHTML(text);

        safe = safe.replace(/`([^`]+)`/g, "<code>$1</code>");
        safe = safe.replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>");
        safe = safe.replace(/\*(.+?)\*/g, "<em>$1</em>");

        return safe;
    }

    for (const originalLine of lines) {
        const line = originalLine.trim();

        if (!line) {
            flushParagraph();
            closeList();
            continue;
        }

        const heading = line.match(/^(#{1,3})\s+(.+)$/);

        if (heading) {
            flushParagraph();
            closeList();

            const level = heading[1].length;
            output.push(
                `<h${level}>${inlineMarkdown(heading[2])}</h${level}>`
            );

            continue;
        }

        if (/^---+$/.test(line)) {
            flushParagraph();
            closeList();
            output.push("<hr>");
            continue;
        }

        if (/^>\s?/.test(line)) {
            flushParagraph();
            closeList();
            output.push(
                `<blockquote>${inlineMarkdown(line.replace(/^>\s?/, ""))}</blockquote>`
            );
            continue;
        }

        const bullet = line.match(/^[-*+]\s+(.+)$/);

        if (bullet) {
            flushParagraph();

            if (listType !== "ul") {
                closeList();
                output.push("<ul>");
                listType = "ul";
            }

            output.push(`<li>${inlineMarkdown(bullet[1])}</li>`);
            continue;
        }

        const numbered = line.match(/^\d+[.)]\s+(.+)$/);

        if (numbered) {
            flushParagraph();

            if (listType !== "ol") {
                closeList();
                output.push("<ol>");
                listType = "ol";
            }

            output.push(`<li>${inlineMarkdown(numbered[1])}</li>`);
            continue;
        }

        closeList();
        paragraph.push(line);
    }

    flushParagraph();
    closeList();

    return output.join("\n");
}

// --------------------------------------------------
// Display results
// --------------------------------------------------

function displayTextResult(text, title) {
    currentResult = {
        type: "text",
        text: String(text || "")
    };

    currentResultTitle = title;

    $("#resultTitle").textContent = title;
    $("#resultContent").innerHTML = renderMarkdown(text);

    showResults();
}

function displayFlashcards(cards, title) {
    if (!Array.isArray(cards) || cards.length === 0) {
        showToolMessage("No flashcards were returned. Try again.");
        return;
    }

    currentResult = {
        type: "flashcards",
        cards
    };

    currentResultTitle = title;
    $("#resultTitle").textContent = title;

    const container = $("#resultContent");
    container.replaceChildren();

    cards.forEach((card, index) => {
        const details = document.createElement("details");
        details.className = "flashcard";

        const summary = document.createElement("summary");
        summary.textContent = `${index + 1}. ${card.front}`;

        const answer = document.createElement("p");
        answer.textContent = card.back;

        const topic = document.createElement("p");
        topic.className = "muted";
        topic.textContent = `Topic: ${card.topic || "General"}`;

        details.append(summary, answer, topic);
        container.appendChild(details);
    });

    showResults();
}

function showResults() {
    $("#resultsPanel").hidden = false;
    $("#progressPanel").hidden = true;

    $("#resultsPanel").scrollIntoView({
        behavior: "smooth",
        block: "start"
    });
}

// --------------------------------------------------
// Quiz rendering, scoring, and weak-topic tracking
// --------------------------------------------------

function displayQuiz(questions, title) {
    if (!Array.isArray(questions) || questions.length === 0) {
        showToolMessage("The AI did not return any quiz questions.");
        return;
    }

    currentQuiz = {
        title,
        questions
    };

    quizSubmitted = false;
    currentResult = {
        type: "quiz",
        title,
        questions
    };

    currentResultTitle = title;

    $("#resultTitle").textContent = title;

    const container = $("#resultContent");
    container.replaceChildren();

    questions.forEach((question, index) => {
        const article = document.createElement("article");
        article.className = "quiz-question";

        const heading = document.createElement("h4");
        heading.textContent = `${index + 1}. ${question.question}`;

        const topic = document.createElement("p");
        topic.className = "muted";
        topic.textContent = `Topic: ${question.topic || "General"}`;

        article.append(heading, topic);

        question.options.forEach((option, optionIndex) => {
            const label = document.createElement("label");
            label.className = "quiz-option";

            const input = document.createElement("input");
            input.type = "radio";
            input.name = `question-${index}`;
            input.value = String(optionIndex);

            const text = document.createElement("span");
            text.textContent = option;

            label.append(input, text);
            article.appendChild(label);
        });

        const feedback = document.createElement("div");
        feedback.className = "quiz-feedback";
        feedback.hidden = true;
        feedback.id = `feedback-${index}`;

        article.appendChild(feedback);
        container.appendChild(article);
    });

    const submitButton = document.createElement("button");
    submitButton.className = "primary-button";
    submitButton.textContent = "Submit Quiz";
    submitButton.id = "submitQuizButton";

    submitButton.addEventListener("click", submitQuiz);

    container.appendChild(submitButton);

    showResults();
}

function submitQuiz() {
    if (!currentQuiz || quizSubmitted) return;

    let correct = 0;
    const wrongTopics = [];

    currentQuiz.questions.forEach((question, index) => {
        const selected = document.querySelector(
            `input[name="question-${index}"]:checked`
        );

        const selectedIndex = selected ? Number(selected.value) : -1;
        const isCorrect = selectedIndex === Number(question.answer);

        if (isCorrect) {
            correct++;
        } else {
            wrongTopics.push(question.topic || "General");
        }

        const feedback = $(`#feedback-${index}`);
        feedback.hidden = false;

        const answerText = question.options[Number(question.answer)];

        feedback.textContent =
            `${isCorrect ? "Correct!" : "Not quite."} ` +
            `Correct answer: ${answerText}. ` +
            `${question.explanation || ""}`;

        feedback.style.color = isCorrect ? "#6ce5d2" : "#ffb4b4";
    });

    quizSubmitted = true;

    const total = currentQuiz.questions.length;
    const score = Math.round((correct / total) * 100);

    const scores = loadStorage(STORAGE_KEYS.scores, []);

    scores.push({
        date: new Date().toISOString(),
        correct,
        total,
        score,
        weakTopics: [...new Set(wrongTopics)]
    });

    saveStorage(STORAGE_KEYS.scores, scores.slice(-100));

    const summary = document.createElement("section");
    summary.className = "panel";

    const heading = document.createElement("h3");
    heading.textContent = `Your Score: ${correct}/${total} (${score}%)`;

    const text = document.createElement("p");
    text.textContent = score >= 80
        ? "Great work! Keep revising to maintain your understanding."
        : "Review the explanations above and practise the topics you missed.";

    summary.append(heading, text);

    if (wrongTopics.length) {
        const weak = document.createElement("p");
        weak.textContent = "Topics to practise: " +
            [...new Set(wrongTopics)].join(", ");
        summary.appendChild(weak);
    }

    $("#resultContent").appendChild(summary);

    const button = $("#submitQuizButton");

    if (button) {
        button.disabled = true;
        button.textContent = "Quiz Submitted";
    }
}

// --------------------------------------------------
// Copy, download, and save materials
// --------------------------------------------------

function getPlainResultText() {
    if (!currentResult) return "";

    if (currentResult.type === "text") {
        return currentResult.text;
    }

    if (currentResult.type === "flashcards") {
        return currentResult.cards.map((card, index) =>
            `${index + 1}. ${card.front}\n${card.back}`
        ).join("\n\n");
    }

    if (currentResult.type === "quiz") {
        return currentResult.questions.map((question, index) => {
            const answer = question.options[Number(question.answer)];

            return `${index + 1}. ${question.question}\n` +
                `${question.options.map((option, i) => `${String.fromCharCode(65 + i)}. ${option}`).join("\n")}\n` +
                `Answer: ${answer}\nExplanation: ${question.explanation}`;
        }).join("\n\n");
    }

    return "";
}

$("#copyButton").addEventListener("click", async () => {
    const text = getPlainResultText();

    try {
        await navigator.clipboard.writeText(text);
        $("#copyButton").textContent = "Copied!";
    } catch {
        showToolMessage(
            "Copying was blocked by the browser. Try downloading the material instead."
        );
    }
});

$("#downloadButton").addEventListener("click", () => {
    const text = getPlainResultText();

    if (!text) return;

    const blob = new Blob([text], {
        type: "text/plain;charset=utf-8"
    });

    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");

    link.href = url;
    link.download = `${safeFilename(currentResultTitle)}.txt`;

    document.body.appendChild(link);
    link.click();
    link.remove();

    URL.revokeObjectURL(url);
});

function safeFilename(value) {
    return String(value || "ascend-study-material")
        .replace(/[^a-z0-9-_ ]/gi, "")
        .trim()
        .replace(/\s+/g, "-")
        .slice(0, 80) || "ascend-study-material";
}

$("#saveButton").addEventListener("click", () => {
    if (!currentResult) return;

    const materials = loadStorage(STORAGE_KEYS.materials, []);

    materials.unshift({
        id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        title: currentResultTitle,
        type: currentResult.type,
        text: getPlainResultText(),
        date: new Date().toISOString()
    });

    saveStorage(STORAGE_KEYS.materials, materials.slice(0, 50));

    $("#saveButton").textContent = "Saved!";
});

// --------------------------------------------------
// Progress dashboard and revision checklist
// --------------------------------------------------

function openProgress() {
    $("#toolPanel").hidden = true;
    $("#resultsPanel").hidden = true;
    $("#progressPanel").hidden = false;

    renderProgress();

    $("#progressPanel").scrollIntoView({
        behavior: "smooth",
        block: "start"
    });
}

function renderProgress() {
    const scores = loadStorage(STORAGE_KEYS.scores, []);
    const materials = loadStorage(STORAGE_KEYS.materials, []);

    $("#quizTotal").textContent = scores.length;

    const average = scores.length
        ? Math.round(scores.reduce((sum, item) => sum + item.score, 0) / scores.length)
        : 0;

    $("#averageScore").textContent = `${average}%`;
    $("#savedTotal").textContent = materials.length;

    renderChecklist();
    renderSavedMaterials();
}

$("#checklistForm").addEventListener("submit", (event) => {
    event.preventDefault();

    const input = $("#topicInput");
    const topic = input.value.trim();

    if (!topic) return;

    const items = loadStorage(STORAGE_KEYS.checklist, []);

    items.push({
        id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        topic,
        status: "Not started"
    });

    saveStorage(STORAGE_KEYS.checklist, items);
    input.value = "";

    renderChecklist();
});

function renderChecklist() {
    const container = $("#checklistItems");
    const items = loadStorage(STORAGE_KEYS.checklist, []);

    container.replaceChildren();

    if (!items.length) {
        const empty = document.createElement("p");
        empty.className = "muted";
        empty.textContent = "Your revision checklist is empty.";
        container.appendChild(empty);
        return;
    }

    items.forEach((item) => {
        const row = document.createElement("div");
        row.className = "checklist-item";

        const topic = document.createElement("span");
        topic.textContent = item.topic;

        const controls = document.createElement("div");
        controls.className = "checklist-controls";

        const select = document.createElement("select");

        [
            "Not started",
            "In progress",
            "Revised",
            "Needs practice"
        ].forEach((status) => {
            const option = document.createElement("option");
            option.value = status;
            option.textContent = status;
            option.selected = item.status === status;
            select.appendChild(option);
        });

        select.addEventListener("change", () => {
            const current = loadStorage(STORAGE_KEYS.checklist, []);
            const updated = current.map((entry) =>
                entry.id === item.id
                    ? { ...entry, status: select.value }
                    : entry
            );

            saveStorage(STORAGE_KEYS.checklist, updated);
        });

        const remove = document.createElement("button");
        remove.className = "secondary-button";
        remove.textContent = "Remove";

        remove.addEventListener("click", () => {
            const updated = loadStorage(STORAGE_KEYS.checklist, [])
                .filter((entry) => entry.id !== item.id);

            saveStorage(STORAGE_KEYS.checklist, updated);
            renderChecklist();
        });

        controls.append(select, remove);
        row.append(topic, controls);
        container.appendChild(row);
    });
}

function renderSavedMaterials() {
    const container = $("#savedMaterials");
    const materials = loadStorage(STORAGE_KEYS.materials, []);

    container.replaceChildren();

    if (!materials.length) {
        const empty = document.createElement("p");
        empty.className = "muted";
        empty.textContent = "No saved materials yet.";
        container.appendChild(empty);
        return;
    }

    materials.forEach((material) => {
        const row = document.createElement("div");
        row.className = "saved-item";

        const info = document.createElement("span");
        info.textContent =
            `${material.title} · ${new Date(material.date).toLocaleDateString()}`;

        const actions = document.createElement("div");

        const open = document.createElement("button");
        open.className = "secondary-button";
        open.textContent = "Open";

        open.addEventListener("click", () => {
            displayTextResult(material.text, material.title);
        });

        const remove = document.createElement("button");
        remove.className = "secondary-button";
        remove.textContent = "Delete";

        remove.addEventListener("click", () => {
            const updated = loadStorage(STORAGE_KEYS.materials, [])
                .filter((entry) => entry.id !== material.id);

            saveStorage(STORAGE_KEYS.materials, updated);
            renderProgress();
        });

        actions.append(open, remove);
        row.append(info, actions);
        container.appendChild(row);
    });
}

// --------------------------------------------------
// Weak-topic practice
// --------------------------------------------------

$("#weakPracticeButton").addEventListener("click", () => {
    const scores = loadStorage(STORAGE_KEYS.scores, []);

    const topics = [
        ...new Set(scores.flatMap((entry) => entry.weakTopics || []))
    ];

    if (!topics.length) {
        alert("Complete a quiz first. Topics you miss will appear here.");
        return;
    }

    const topic = topics[0];

    const syllabusInput = $("#syllabusInput");

    syllabusInput.value = "";

    openTool("quiz");

    alert(
        `Your practice list includes: ${topics.join(", ")}.\n\n` +
        `The quiz generator uses your uploaded notes. For targeted practice, ` +
        `consider uploading notes about ${topic} before generating another quiz.`
    );
});

// --------------------------------------------------
// Initial state
// --------------------------------------------------

$("#toolPanel").hidden = true;
$("#resultsPanel").hidden = true;
$("#progressPanel").hidden = true;

showLanding();