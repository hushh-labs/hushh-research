/** An unresolved dispatch or runtime refusal must not trigger automatic model replay. */
export class AnswerPreparationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AnswerPreparationError";
  }
}
