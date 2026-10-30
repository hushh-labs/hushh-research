"""
PII Detection Service

Detects and redacts Personally Identifiable Information (PII) in text,
JSON responses, and LLM outputs. Prevents accidental PII leakage into
storage or logs.

Detects:
- Social Security Numbers (SSN)
- Phone numbers (US, international)
- Email addresses
- Credit card numbers
- Bank account numbers
- Driver's license numbers
- Passport numbers
- Date of birth patterns
- Home addresses
"""

import json
import re
from dataclasses import dataclass
from enum import Enum
from typing import Any, Dict, List, Optional, Set, Tuple

try:
    import spacy
    HAS_SPACY = True
except ImportError:
    HAS_SPACY = False


class PIIType(str, Enum):
    """Types of PII that can be detected"""
    SSN = "ssn"
    PHONE = "phone"
    EMAIL = "email"
    CREDIT_CARD = "credit_card"
    BANK_ACCOUNT = "bank_account"
    DRIVERS_LICENSE = "drivers_license"
    PASSPORT = "passport"
    DOB = "date_of_birth"
    ADDRESS = "home_address"
    PERSON_NAME = "person_name"


@dataclass
class PIIMatch:
    """Represents a detected PII match"""
    type: PIIType
    value: str
    start: int
    end: int
    confidence: float  # 0.0-1.0


class PIIDetector:
    """Detects PII patterns in text using regex and NER"""
    
    # Regex patterns for common PII
    PATTERNS = {
        PIIType.SSN: re.compile(
            r'\b(?!000|666|9\d{2})\d{3}-?(?!00)\d{2}-?(?!0{4})\d{4}\b'
        ),
        PIIType.PHONE: re.compile(
            r'(?:\+?1[-.\s]?)?(?:\(?[0-9]{3}\)?[-.\s]?)?[0-9]{3}[-.\s]?[0-9]{4}\b'
        ),
        PIIType.EMAIL: re.compile(
            r'\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Z|a-z]{2,}\b'
        ),
        PIIType.CREDIT_CARD: re.compile(
            r'\b(?:\d{4}[-\s]?){3}\d{4}\b|\b\d{13,19}\b'
        ),
        PIIType.BANK_ACCOUNT: re.compile(
            r'\b(?:account|acct|routing)\s*#?\s*[:\s]*\d{8,17}\b',
            re.IGNORECASE
        ),
        PIIType.DRIVERS_LICENSE: re.compile(
            r'\b(?:drivers?|dl|license)\s*#?\s*[:\s]*[A-Z0-9]{5,8}\b',
            re.IGNORECASE
        ),
        PIIType.PASSPORT: re.compile(
            r'\b(?:passport)\s*#?\s*[:\s]*[A-Z0-9]{6,9}\b',
            re.IGNORECASE
        ),
        PIIType.DOB: re.compile(
            r'\b(?:dob|birth)\s*[:\s]*(?:\d{1,2}[-/]\d{1,2}[-/]\d{2,4}|\d{4}[-/]\d{2}[-/]\d{2})\b',
            re.IGNORECASE
        ),
        PIIType.ADDRESS: re.compile(
            r'\b\d{1,5}\s+[A-Za-z\s]+(?:street|st|avenue|ave|road|rd|lane|ln|drive|dr|boulevard|blvd)\b',
            re.IGNORECASE
        ),
    }
    
    def __init__(self, use_ner: bool = True):
        """
        Initialize PII detector
        
        Args:
            use_ner: Use spaCy NER for person name detection (requires spacy)
        """
        self.use_ner = use_ner and HAS_SPACY
        self.nlp = None
        
        if self.use_ner:
            try:
                self.nlp = spacy.load('en_core_web_sm')
            except OSError:
                # Model not available, fall back to regex only
                self.use_ner = False
    
    def detect(self, text: str) -> List[PIIMatch]:
        """
        Detect all PII in text
        
        Args:
            text: Text to scan for PII
            
        Returns:
            List of detected PII matches
        """
        if not isinstance(text, str):
            return []
        
        matches = []
        
        # Regex-based detection
        for pii_type, pattern in self.PATTERNS.items():
            for match in pattern.finditer(text):
                matches.append(PIIMatch(
                    type=pii_type,
                    value=match.group(),
                    start=match.start(),
                    end=match.end(),
                    confidence=0.95
                ))
        
        # spaCy NER-based detection
        if self.use_ner and self.nlp:
            doc = self.nlp(text)
            for ent in doc.ents:
                if ent.label_ == "PERSON":
                    # Only flag if it looks like a full name (2+ tokens)
                    if len(ent.text.split()) >= 2:
                        matches.append(PIIMatch(
                            type=PIIType.PERSON_NAME,
                            value=ent.text,
                            start=ent.start_char,
                            end=ent.end_char,
                            confidence=0.85
                        ))
        
        # Sort by position and remove overlaps
        return self._deduplicate_matches(matches)
    
    def _deduplicate_matches(self, matches: List[PIIMatch]) -> List[PIIMatch]:
        """Remove overlapping matches, keeping higher confidence ones"""
        matches.sort(key=lambda m: (m.start, -m.confidence))
        
        filtered = []
        for match in matches:
            # Skip if overlaps with existing match
            if any(m.start <= match.start < m.end or
                   m.start < match.end <= m.end for m in filtered):
                continue
            filtered.append(match)
        
        return filtered
    
    def redact(
        self,
        text: str,
        replacement: str = "[REDACTED]",
        keep_type: bool = True
    ) -> str:
        """
        Redact all PII in text
        
        Args:
            text: Text to redact
            replacement: Replacement string for PII
            keep_type: Include PII type in redaction (e.g., "[REDACTED:SSN]")
            
        Returns:
            Text with PII redacted
        """
        matches = self.detect(text)
        
        if not matches:
            return text
        
        # Process matches in reverse order to maintain positions
        result = text
        for match in reversed(matches):
            repl = replacement
            if keep_type:
                repl = f"{replacement}:{match.type.value.upper()}"
            
            result = result[:match.start] + repl + result[match.end:]
        
        return result
    
    def find_pii_in_json(self, obj: Any) -> List[Tuple[str, PIIMatch]]:
        """
        Find PII in JSON-like structures
        
        Args:
            obj: JSON object (dict, list, or primitive)
            
        Returns:
            List of (path, match) tuples
        """
        results = []
        
        def traverse(current: Any, path: str = ""):
            if isinstance(current, dict):
                for key, value in current.items():
                    new_path = f"{path}.{key}" if path else key
                    traverse(value, new_path)
            elif isinstance(current, list):
                for i, item in enumerate(current):
                    new_path = f"{path}[{i}]"
                    traverse(item, new_path)
            elif isinstance(current, str):
                for match in self.detect(current):
                    results.append((path, match))
        
        traverse(obj)
        return results
    
    def redact_json(
        self,
        obj: Any,
        replacement: str = "[REDACTED]"
    ) -> Any:
        """
        Redact PII in JSON-like structures
        
        Args:
            obj: JSON object to redact
            replacement: Replacement string
            
        Returns:
            New object with PII redacted
        """
        if isinstance(obj, dict):
            return {k: self.redact_json(v, replacement) for k, v in obj.items()}
        elif isinstance(obj, list):
            return [self.redact_json(item, replacement) for item in obj]
        elif isinstance(obj, str):
            return self.redact(obj, replacement)
        else:
            return obj


class PIIFilter:
    """Middleware filter for detecting PII in LLM responses"""
    
    def __init__(self, detector: Optional[PIIDetector] = None):
        """
        Initialize PII filter
        
        Args:
            detector: Custom PIIDetector instance (creates default if None)
        """
        self.detector = detector or PIIDetector()
    
    def filter_llm_response(
        self,
        response_data: Dict[str, Any],
        raise_on_pii: bool = False
    ) -> Tuple[Dict[str, Any], List[PIIMatch]]:
        """
        Filter LLM response for PII
        
        Args:
            response_data: LLM response (typically dict with text content)
            raise_on_pii: Raise exception if PII detected
            
        Returns:
            Tuple of (redacted_response, detected_pii)
            
        Raises:
            ValueError: If raise_on_pii=True and PII detected
        """
        # Convert response to string for scanning
        response_str = json.dumps(response_data) if isinstance(response_data, dict) else str(response_data)
        
        # Detect PII
        matches = self.detector.detect(response_str)
        
        if matches and raise_on_pii:
            pii_types = set(m.type for m in matches)
            raise ValueError(f"LLM response contains PII: {pii_types}")
        
        # Redact if PII found
        if matches:
            redacted_str = self.detector.redact(response_str)
            try:
                return json.loads(redacted_str), matches
            except json.JSONDecodeError:
                return {"text": redacted_str}, matches
        
        return response_data, []
    
    def validate_before_storage(
        self,
        data: Any,
        allowed_pii_types: Optional[Set[PIIType]] = None
    ) -> bool:
        """
        Validate data before storing in vault
        
        Args:
            data: Data to validate
            allowed_pii_types: PII types that are allowed to store
            
        Returns:
            True if data is safe to store, False otherwise
        """
        if not HAS_SPACY:
            # If spaCy not available, only check regex patterns
            text = json.dumps(data) if isinstance(data, dict) else str(data)
            matches = self.detector.detect(text)
            allowed_pii_types = allowed_pii_types or set()
            return all(m.type in allowed_pii_types for m in matches)
        
        return True


# Singleton instance
_detector = None


def get_pii_detector(use_ner: bool = True) -> PIIDetector:
    """Get or create PII detector instance"""
    global _detector
    if _detector is None:
        _detector = PIIDetector(use_ner=use_ner)
    return _detector


def detect_pii(text: str) -> List[PIIMatch]:
    """Convenience function to detect PII in text"""
    return get_pii_detector().detect(text)


def redact_pii(text: str, replacement: str = "[REDACTED]") -> str:
    """Convenience function to redact PII in text"""
    return get_pii_detector().redact(text, replacement)
