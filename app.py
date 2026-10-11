from pathlib import Path
import json
import logging
import re
import pytesseract

import requests
pytesseract.pytesseract.tesseract_cmd = (
    r"C:\Program Files\Tesseract-OCR\tesseract.exe"
)
from flask import Flask, jsonify, request, send_from_directory

BASE_DIR = Path(__file__).resolve().parent

app = Flask(__name__)
app.config["MAX_CONTENT_LENGTH"] = 15 * 1024 * 1024

logging.basicConfig(level=logging.INFO)

OLLAMA_URL = "http://localhost:11434/api/generate"
OLLAMA_MODEL = "qwen2.5:3b"

MAX_TEXT_LENGTH = 20000

ALLOWED_EXTENSIONS = {
    ".txt",
    ".pdf",
    ".png",
    ".jpg",
    ".jpeg",
    ".webp",
}


# --------------------------------------------------
# Website routes
# --------------------------------------------------

@app.get("/")
def home():
    return send_from_directory(BASE_DIR, "index.html")


@app.get("/<path:filename>")
def website_files(filename):
    return send_from_directory(BASE_DIR, filename)


# --------------------------------------------------
# File extraction
# --------------------------------------------------

def extract_text(uploaded_file):
    """
    Extract text from TXT, PDF, and image files.
    Scanned PDFs may require OCR and are handled
    separately from ordinary text-based PDFs.
    """

    if not uploaded_file or not uploaded_file.filename:
        raise ValueError("Please select a file first.")

    extension = Path(uploaded_file.filename).suffix.lower()

    if extension not in ALLOWED_EXTENSIONS:
        raise ValueError(
            "Unsupported file type. Upload TXT, PDF, "
            "PNG, JPG, JPEG, or WEBP."
        )

    raw_data = uploaded_file.read()

    if not raw_data:
        raise ValueError("The selected file is empty.")

    if extension == ".txt":
        try:
            text = raw_data.decode("utf-8-sig")
        except UnicodeDecodeError:
            text = raw_data.decode("utf-8", errors="replace")

    elif extension == ".pdf":
        text = extract_pdf_text(raw_data)

    else:
        text = extract_image_text(raw_data)

    text = text.strip()

    if not text:
        raise ValueError(
            "No readable text was found. If this is a scanned "
            "PDF, try a text-based PDF or upload its pages as "
            "images after configuring OCR."
        )

    if len(text) > MAX_TEXT_LENGTH:
        text = text[:MAX_TEXT_LENGTH]

    return text


def extract_pdf_text(raw_data):
    """Extract text from an ordinary, text-based PDF."""

    import fitz

    document = fitz.open(stream=raw_data, filetype="pdf")

    try:
        pages = []

        for page in document:
            pages.append(page.get_text("text"))

        text = "\n\n".join(pages).strip()

    finally:
        document.close()

    if not text:
        raise ValueError(
            "This PDF contains no extractable text. "
            "It may be scanned. Use a text-based PDF or "
            "upload page images after setting up OCR."
        )

    return text


def extract_image_text(raw_data):
    """Use Tesseract OCR to extract text from an image."""

    from PIL import Image
    import pytesseract
    from io import BytesIO

    try:
        image = Image.open(BytesIO(raw_data))
        image.load()

        text = pytesseract.image_to_string(image)

    except Exception as error:
        app.logger.warning("Image OCR failed: %s", error)

        raise ValueError(
            "Could not read this image. Check that Tesseract "
            "OCR is installed and configured on Windows."
        ) from error

    if not text.strip():
        raise ValueError(
            "No readable text was detected in this image."
        )

    return text


# --------------------------------------------------
# Ollama connection
# --------------------------------------------------

def ask_ollama(prompt, json_mode=False):
    """Send a prompt to the locally running Ollama model."""

    payload = {
        "model": OLLAMA_MODEL,
        "prompt": prompt,
        "stream": False,
    }

    if json_mode:
        payload["format"] = "json"

    try:
        response = requests.post(
            OLLAMA_URL,
            json=payload,
            timeout=(10, 240),
        )

        response.raise_for_status()

        result = response.json()
        answer = result.get("response", "").strip()

        if not answer:
            raise RuntimeError(
                "The AI returned an empty response."
            )

        return answer

    except requests.exceptions.ConnectionError as error:
        raise RuntimeError(
            "Cannot connect to Ollama. Open another terminal "
            "and run: ollama serve. If Ollama is already "
            "running, leave it running and try again."
        ) from error

    except requests.exceptions.Timeout as error:
        raise RuntimeError(
            "The AI took too long to respond. Try shorter "
            "notes or try again."
        ) from error

    except requests.exceptions.RequestException as error:
        app.logger.exception("Ollama request failed")

        raise RuntimeError(
            "The AI request failed. Check Ollama and try again."
        ) from error


def ask_for_json(prompt):
    """Ask Ollama for JSON and validate the response."""

    answer = ask_ollama(prompt, json_mode=True)

    try:
        data = json.loads(answer)

    except json.JSONDecodeError as error:
        app.logger.warning("Invalid JSON from Ollama: %s", answer)

        raise RuntimeError(
            "The AI returned an invalid structured response. "
            "Please try again."
        ) from error

    if not isinstance(data, dict):
        raise RuntimeError(
            "The AI returned an unexpected response format."
        )

    return data


# --------------------------------------------------
# Request helpers
# --------------------------------------------------

def read_notes_from_request():
    """Read and extract the uploaded notes file."""

    uploaded_file = request.files.get("file")

    if not uploaded_file:
        raise ValueError("Please upload your notes file.")

    return extract_text(uploaded_file)


def get_notes_prompt(notes, task):
    return f"""
You are Ascend, a careful educational revision assistant.

Task:
{task}

Rules:
- Use clear headings and subheadings.
- Explain difficult ideas in student-friendly language.
- Preserve important facts, definitions, dates, formulas,
  examples, and terminology found in the notes.
- Do not invent facts or pretend missing information
  appeared in the original notes.
- Clearly label reasonable additional explanations.
- Point out uncertainty when the source is unclear.
- Make the result useful for revision and understanding.

STUDENT NOTES:
---
{notes}
---
"""


# --------------------------------------------------
# 1. Generate revision notes
# --------------------------------------------------

@app.post("/api/organize")
def organize_notes():
    try:
        notes = read_notes_from_request()

        prompt = get_notes_prompt(
            notes,
            """
Create complete, well-organized revision notes.

Include:
1. A descriptive title.
2. Topic headings and subheadings.
3. Important definitions.
4. Step-by-step explanations where helpful.
5. Important facts, examples, and formulas.
6. Common misunderstandings when relevant.
7. Key Takeaways.
8. A short Self-Check section with five questions.

Use Markdown formatting.
Do not include raw HTML.
"""
        )

        result = ask_ollama(prompt)

        return jsonify({
            "organized_notes": result,
            "title": "Revision Notes",
        })

    except ValueError as error:
        return jsonify({"error": str(error)}), 400

    except RuntimeError as error:
        return jsonify({"error": str(error)}), 502


# --------------------------------------------------
# 2. Syllabus-gap analysis
# --------------------------------------------------

@app.post("/api/syllabus-gap")
def syllabus_gap():
    try:
        notes = read_notes_from_request()

        syllabus = request.form.get("syllabus", "").strip()

        if not syllabus:
            return jsonify({
                "error": (
                    "Enter or upload your syllabus before "
                    "checking for gaps."
                )
            }), 400

        if len(syllabus) > MAX_TEXT_LENGTH:
            syllabus = syllabus[:MAX_TEXT_LENGTH]

        prompt = f"""
You are Ascend, a careful study-planning assistant.

Compare the syllabus with the student's provided notes.

SYLLABUS:
---
{syllabus}
---

STUDENT NOTES:
---
{notes}
---

Create a Markdown report with these sections:

# Syllabus Coverage Report

## Covered Well
List syllabus topics supported by sufficient evidence
in the supplied notes.

## Partially Covered
List topics that appear in the notes but lack important
details or explanations.

## Not Found in the Provided Notes
List syllabus topics for which you could not find
supporting material in the supplied notes.

## Recommended Study Order
Suggest a sensible order for reviewing missing
or incomplete topics.

## Next Steps
Give the student a short, practical checklist.

Important:
- Compare only the supplied syllabus and notes.
- Do not claim that a topic is absent from the student's
  entire collection if only one file was supplied.
- Do not invent syllabus requirements.
- If the syllabus is unclear, say so.
- A topic not found in the notes is not necessarily
  something the student has never studied.
"""

        result = ask_ollama(prompt)

        return jsonify({
            "report": result,
            "title": "Syllabus Gap Report",
        })

    except ValueError as error:
        return jsonify({"error": str(error)}), 400

    except RuntimeError as error:
        return jsonify({"error": str(error)}), 502


# --------------------------------------------------
# 3. Generate quiz
# --------------------------------------------------

@app.post("/api/quiz")
def generate_quiz():
    try:
        notes = read_notes_from_request()

        difficulty = request.form.get(
            "difficulty", "medium"
        ).lower()

        question_type = request.form.get(
            "question_type", "multiple_choice"
        ).lower()

        try:
            count = int(request.form.get("count", "5"))
        except ValueError:
            count = 5

        if difficulty not in {
            "easy", "medium", "hard", "mixed"
        }:
            difficulty = "medium"

        if question_type not in {
            "multiple_choice", "true_false"
        }:
            question_type = "multiple_choice"

        count = max(5, min(count, 15))

        prompt = f"""
You are Ascend, an educational quiz generator.

Create exactly {count} questions based on the student's notes.

Difficulty: {difficulty}
Question type: {question_type}

Return valid JSON with this structure:

{{
  "title": "Quiz title",
  "questions": [
    {{
      "question": "Question text",
      "options": ["Option A", "Option B", "Option C", "Option D"],
      "answer": 0,
      "explanation": "Why the answer is correct",
      "topic": "Topic name"
    }}
  ]
}}

Rules:
- For multiple_choice, provide four options.
- For true_false, provide exactly two options:
  "True" and "False".
- The answer must be a zero-based integer index
  referring to the correct option.
- Make sure the correct answer is actually correct.
- Write a useful explanation for every answer.
- Assign a concise topic to each question.
- Avoid ambiguous questions.
- Base questions on the supplied notes.
- Do not create trick questions.
- Return JSON only.

STUDENT NOTES:
---
{notes}
---
"""

        data = ask_for_json(prompt)

        questions = data.get("questions")

        if not isinstance(questions, list):
            raise RuntimeError(
                "The AI did not return a valid question list."
            )

        valid_questions = []

        for item in questions:
            if not isinstance(item, dict):
                continue

            question = str(item.get("question", "")).strip()
            options = item.get("options")
            explanation = str(
                item.get("explanation", "")
            ).strip()

            try:
                answer = int(item.get("answer"))
            except (TypeError, ValueError):
                continue

            if not question or not isinstance(options, list):
                continue

            options = [
                str(option).strip()
                for option in options
            ]

            if len(options) != 2 and question_type == "true_false":
                continue

            if len(options) != 4 and question_type == "multiple_choice":
                continue

            if answer < 0 or answer >= len(options):
                continue

            if not explanation:
                explanation = "Review the relevant topic in your notes."

            valid_questions.append({
                "question": question,
                "options": options,
                "answer": answer,
                "explanation": explanation,
                "topic": str(
                    item.get("topic", "General")
                ).strip() or "General",
            })

        if not valid_questions:
            raise RuntimeError(
                "The AI could not create a valid quiz. "
                "Try generating it again."
            )

        return jsonify({
            "title": data.get("title", "Practice Quiz"),
            "questions": valid_questions[:count],
            "difficulty": difficulty,
            "question_type": question_type,
        })

    except ValueError as error:
        return jsonify({"error": str(error)}), 400

    except RuntimeError as error:
        return jsonify({"error": str(error)}), 502


# --------------------------------------------------
# 4. Generate flashcards
# --------------------------------------------------

@app.post("/api/flashcards")
def generate_flashcards():
    try:
        notes = read_notes_from_request()

        prompt = f"""
You are Ascend, an educational flashcard generator.

Create 8 to 15 useful flashcards from the notes.

Return valid JSON:

{{
  "title": "Flashcard set title",
  "flashcards": [
    {{
      "front": "A question or term",
      "back": "A concise answer or definition",
      "topic": "Topic name"
    }}
  ]
}}

Rules:
- Test important definitions, concepts, facts, and formulas.
- Keep each card focused on one concept.
- Make answers concise but accurate.
- Do not invent information.
- Return JSON only.

NOTES:
---
{notes}
---
"""

        data = ask_for_json(prompt)
        cards = data.get("flashcards", [])

        if not isinstance(cards, list):
            raise RuntimeError(
                "The AI returned an invalid flashcard set."
            )

        valid_cards = []

        for card in cards:
            if not isinstance(card, dict):
                continue

            front = str(card.get("front", "")).strip()
            back = str(card.get("back", "")).strip()

            if not front or not back:
                continue

            valid_cards.append({
                "front": front,
                "back": back,
                "topic": str(
                    card.get("topic", "General")
                ).strip() or "General",
            })

        if not valid_cards:
            raise RuntimeError(
                "No usable flashcards were generated."
            )

        return jsonify({
            "title": data.get("title", "Flashcards"),
            "flashcards": valid_cards[:20],
        })

    except ValueError as error:
        return jsonify({"error": str(error)}), 400

    except RuntimeError as error:
        return jsonify({"error": str(error)}), 502


# --------------------------------------------------
# 5. Generate a quick revision sheet
# --------------------------------------------------

@app.post("/api/quick-revision")
def quick_revision():
    try:
        notes = read_notes_from_request()

        prompt = get_notes_prompt(
            notes,
            """
Create a concise last-minute revision sheet.

Include:
- Topic overview
- Essential definitions
- Key facts and formulas
- Important relationships or steps
- Common mistakes to avoid
- Five rapid-recall prompts

Keep it concise and easy to scan.
Use Markdown headings and bullet points.
Do not add unsupported facts.
"""
        )

        result = ask_ollama(prompt)

        return jsonify({
            "revision_sheet": result,
            "title": "Quick Revision Sheet",
        })

    except ValueError as error:
        return jsonify({"error": str(error)}), 400

    except RuntimeError as error:
        return jsonify({"error": str(error)}), 502


# --------------------------------------------------
# Error handling
# --------------------------------------------------

@app.errorhandler(413)
def file_too_large(error):
    return jsonify({
        "error": "File too large. Maximum size is 15 MB."
    }), 413


@app.errorhandler(404)
def not_found(error):
    if request.path.startswith("/api/"):
        return jsonify({
            "error": "The requested API endpoint was not found."
        }), 404

    return "Page not found", 404


if __name__ == "__main__":
    app.run(
        host="127.0.0.1",
        port=5000,
        debug=False,
    )