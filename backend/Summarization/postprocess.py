def postprocess(text):
    text = text.strip()
    if len(text) > 1:
        text = text[0].upper() + text[1:]
    return text