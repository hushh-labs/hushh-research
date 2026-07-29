    it("strips Windows carriage-return newlines from a backend URL env var without throwing", async () => {
      process.env.K_SERVICE = "hushh-webapp";
      process.env.PYTHON_API_URL = "https://api.example.com\r\n";
      const helper = await loadHelper();
      expect(helper.getPythonApiUrl()).toBe("https://api.example.com");
    });