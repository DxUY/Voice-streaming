import os
import torch
from transformers import AutoTokenizer, AutoModelForSeq2SeqLM

class Summarizer:
    def __init__(self):
        BASE_DIR = os.path.dirname(os.path.dirname(__file__))
        model_path = os.path.join(BASE_DIR, "models", "fine_tuned")

        print("🔄 Loading model...")
        print("📁 Path:", model_path)

        if not os.path.exists(model_path):
            raise Exception("❌ Model not found!")

        self.tokenizer = AutoTokenizer.from_pretrained(model_path)
        self.model = AutoModelForSeq2SeqLM.from_pretrained(model_path)

        self.device = torch.device("cuda" if torch.cuda.is_available() else "cpu")
        self.model.to(self.device)

        print("✅ Model loaded!")

    def summarize(self, text):
        if not text.strip():
            return "No content."

        chunks = self.split_text(text)
        summaries = []

        for chunk in chunks:
            inputs = self.tokenizer(
                chunk,
                return_tensors="pt",
                truncation=True,
                max_length=512
            ).to(self.device)

            with torch.no_grad():
                output = self.model.generate(
                    inputs["input_ids"],
                    max_length=150,
                    min_length=40,
                    num_beams=4,
                    no_repeat_ngram_size=3
                )

            summary = self.tokenizer.decode(output[0], skip_special_tokens=True)
            summaries.append(summary)

        final = " ".join(summaries)

        if not final.endswith("."):
            last_dot = final.rfind(".")
            if last_dot != -1:
                final = final[:last_dot + 1]

        return final

    def split_text(self, text, max_words=150):
        words = text.split()
        return [
            " ".join(words[i:i + max_words])
            for i in range(0, len(words), max_words)
        ]