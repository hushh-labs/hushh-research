  it("normalizes clarify helper contract when options are empty", () => {
    expect(normalizeClarifyToolCall("Which ticker?", [])).toEqual({
      tool_name: "clarify",
      args: {
        question: "Which ticker?",
        options: [],
      },
    });
  });