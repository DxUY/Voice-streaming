from preprocess import clean_text
from model import Summarizer
from postprocess import format_summary

class SummarizationPipeline:
    def __init__(self):
        """
        Initializes the full pipeline. 
        Note: This will load the model into memory/GPU.
        """
        self.summarizer = Summarizer()

    def run(self, raw_text):
        """
        Processes raw text through the full lifecycle: 
        Cleaning -> Inference -> Formatting.
        """
        cleaned_text = clean_text(raw_text)
        
        if not cleaned_text.strip():
            return "Input text is empty."

        raw_summary = self.summarizer.summarize(cleaned_text)

        final_summary = format_summary(raw_summary)
        
        return final_summary