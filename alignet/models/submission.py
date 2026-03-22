"""
Submission models for Alignet Subnet.

This module defines the miner submission system for seed instructions.
"""

from datetime import datetime
from typing import Dict, Any, Optional, List, Union
from pydantic import BaseModel, Field
from enum import Enum
import uuid


class SubmissionStatus(str, Enum):
    """Status of a miner submission."""
    SUBMITTED = "SUBMITTED"
    VALIDATING = "VALIDATING"
    VALIDATION_PASSED = "VALIDATION_PASSED"
    VALIDATION_FAILED = "VALIDATION_FAILED"
    CHALLENGE_CREATED = "CHALLENGE_CREATED"
    EVALUATING = "EVALUATING"
    EVALUATION_COMPLETED = "EVALUATION_COMPLETED"
    SCORING_COMPLETED = "SCORING_COMPLETED"
    FAILED = "FAILED"


class MinerSubmission(BaseModel):
    """A miner's submission for Guard Model Challenge evaluation."""
    
    submission_id: str = Field(
        default_factory=lambda: str(uuid.uuid4()), 
        description="Unique submission identifier"
    )
    challenge_id: str = Field(description="Challenge ID")
    submission_items: Dict[str, Any] = Field(description="Submission items (Q1-Qn), format depends on surface_area")
    surface_area: int = Field(description="Surface area version (1-5)")
    version: str = Field(default="2.0.0", description="Submission version")
    
    # Status and timing
    status: SubmissionStatus = Field(
        default=SubmissionStatus.SUBMITTED, 
        description="Current status of the submission"
    )
    submitted_at: datetime = Field(
        default_factory=datetime.now, 
        description="When the submission was made"
    )
    validated_at: Optional[datetime] = Field(
        default=None, 
        description="When validation was completed"
    )
    evaluated_at: Optional[datetime] = Field(
        default=None, 
        description="When evaluation was completed"
    )
    
    # Validation results
    validation_errors: List[str] = Field(
        default_factory=list, 
        description="Validation errors found"
    )
    validation_warnings: List[str] = Field(
        default_factory=list, 
        description="Validation warnings"
    )
    security_violations: List[str] = Field(
        default_factory=list, 
        description="Security violations detected"
    )
    
    # Evaluation results
    best_score: float = Field(
        default=0.0, 
        ge=0.0, 
        le=1.0, 
        description="Best score achieved from Petri evaluation"
    )
    average_score: float = Field(
        default=0.0, 
        ge=0.0, 
        le=1.0, 
        description="Average score from Petri evaluation"
    )
    
    def update_status(self, new_status: SubmissionStatus) -> None:
        """Update the submission status and timestamps."""
        self.status = new_status
        
        if new_status == SubmissionStatus.VALIDATION_PASSED and not self.validated_at:
            self.validated_at = datetime.now()
        elif new_status == SubmissionStatus.EVALUATION_COMPLETED and not self.evaluated_at:
            self.evaluated_at = datetime.now()
    
    def add_validation_error(self, error: str) -> None:
        """Add a validation error."""
        self.validation_errors.append(error)
    
    def add_validation_warning(self, warning: str) -> None:
        """Add a validation warning."""
        self.validation_warnings.append(warning)
    
    def add_security_violation(self, violation: str) -> None:
        """Add a security violation."""
        self.security_violations.append(violation)
    
    def update_scores(self, scores: List[float]) -> None:
        """Update the best and average scores."""
        if scores:
            self.best_score = max(scores)
            self.average_score = sum(scores) / len(scores)
    
    def is_valid(self) -> bool:
        """Check if the submission is valid."""
        return (
            len(self.validation_errors) == 0 and 
            len(self.security_violations) == 0 and
            self.status not in [SubmissionStatus.VALIDATION_FAILED, SubmissionStatus.FAILED]
        )
    
    def to_evaluation_config_dict(self) -> Dict[str, Any]:
        """Convert to EvaluationConfig dictionary format."""
        return {
            "challenge_id": self.challenge_id,
            "submission_items": self.submission_items,
            "surface_area": self.surface_area,
        }
    
    def to_dict(self) -> Dict[str, Any]:
        """Convert to dictionary for JSON serialization."""
        return {
            "submission_id": self.submission_id,
            "version": self.version,
            "status": self.status.value,
            "submitted_at": self.submitted_at.isoformat(),
            "validated_at": self.validated_at.isoformat() if self.validated_at else None,
            "evaluated_at": self.evaluated_at.isoformat() if self.evaluated_at else None,
            "validation_errors": self.validation_errors,
            "validation_warnings": self.validation_warnings,
            "security_violations": self.security_violations,
            "best_score": self.best_score,
            "average_score": self.average_score,
            "challenge_id": self.challenge_id,
            "submission_items": self.submission_items,
            "surface_area": self.surface_area,
        }
