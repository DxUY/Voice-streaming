import os
import torch
from transformers import AutoTokenizer, AutoModelForSeq2SeqLM
from evaluator import compute_similarity, check_entity_consistency

class Summarizer:
    def __init__(self):
        BASE_DIR = os.path.dirname(__file__) 
        model_path = os.path.join(BASE_DIR, "fine_tuned")
        self.tokenizer = AutoTokenizer.from_pretrained(model_path)
        self.model = AutoModelForSeq2SeqLM.from_pretrained(model_path)
        self.device = torch.device("cuda" if torch.cuda.is_available() else "cpu")
        self.model.to(self.device)

    def summarize(self, text):
        text = text.strip()
        if not text: return "No content."
        
        if len(text.split()) < 15:
            return text

        chunks = self.split_text(text)
        final_results = []

        for chunk in chunks:
            input_text = f"summarize: {chunk}"
            inputs = self.tokenizer(input_text, return_tensors="pt", truncation=True, max_length=512).to(self.device)

            with torch.no_grad():
                output = self.model.generate(
                    inputs["input_ids"],
                    max_length=150,
                    min_length=5,
                    num_beams=5,
                    no_repeat_ngram_size=3,
                    do_sample=False,
                    early_stopping=True
                )

            summary = self.tokenizer.decode(output[0], skip_special_tokens=True)

            is_consistent = check_entity_consistency(chunk, summary)
            similarity_score = compute_similarity(chunk, summary)

            if is_consistent and similarity_score > 0.2:
                final_results.append(summary)
            else:
                final_results.append(chunk)

        final = " ".join(final_results)
        return final if "." not in final else final[:final.rfind(".") + 1]

    def split_text(self, text, max_words=300):
        words = text.split()
        return [" ".join(words[i:i + max_words]) for i in range(0, len(words), max_words)]