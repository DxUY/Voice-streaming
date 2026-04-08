from sklearn.feature_extraction.text import TfidfVectorizer
from sklearn.metrics.pairwise import cosine_similarity
from .ner import extract_entities

def compute_similarity(text, summary):
    vectorizer = TfidfVectorizer()
    tfidf = vectorizer.fit_transform([text, summary])
    return cosine_similarity(tfidf[0:1], tfidf[1:2])[0][0]

def check_entity_consistency(text, summary):
    input_entities = extract_entities(text)
    output_entities = extract_entities(summary)
    return input_entities == output_entities