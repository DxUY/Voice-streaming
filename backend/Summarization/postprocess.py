def postprocess(text):
    text = text.strip()
    if not text:
        return ""
    
    if len(text) > 1:
        text = text[0].upper() + text[1:]
    
    if text and text[-1] not in [".", "!", "?"]:
        text += "."
        
    return text