from rouge_score import rouge_scorer
from summarization_pipeline import SummarizationPipeline # Import your class

def read_file(path):
    try:
        with open(path, "r", encoding="utf-8") as f:
            return f.read().strip()
    except FileNotFoundError:
        return None

def evaluate_pipeline():
    # 1. Setup Pipeline and Scorer
    pipeline = SummarizationPipeline()
    scorer = rouge_scorer.RougeScorer(['rouge1', 'rouge2', 'rougeL'], use_stemmer=True)

    # 2. Load Data
    # 'input.txt' contains the long text to summarize
    # 'reference.txt' contains the human-written summary to compare against
    raw_text = read_file("input.txt")
    reference_summary = read_file("output.txt")

    if not raw_text or not reference_summary:
        print("Error: Ensure input.txt and reference.txt exist.")
        return

    # 3. Run Pipeline
    print("Generating summary...")
    generated_summary = pipeline.run(raw_text)

    # 4. Calculate Scores
    # Note: scorer.score(target, prediction)
    scores = scorer.score(reference_summary, generated_summary)

    # 5. Display Results
    print("\n===== PIPELINE OUTPUT =====")
    print(generated_summary)
    print("\n===== ROUGE METRICS =====")
    print(f"ROUGE-1: {scores['rouge1'].fmeasure:.4f}")
    print(f"ROUGE-2: {scores['rouge2'].fmeasure:.4f}")
    print(f"ROUGE-L: {scores['rougeL'].fmeasure:.4f}")

if __name__ == "__main__":
    evaluate_pipeline()