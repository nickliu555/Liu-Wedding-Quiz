# Liu Wedding Quiz

A Kahoot-style real-time quiz web app for ~150 wedding guests. Guests scan a QR code on the big
screen, enter a name on their phone, and answer multiple-choice time-pressured questions. A host laptop
drives the projector view (lobby, question, live answer distribution, top-5 leaderboard between
questions, top-3 podium reveal at the end). Faster correct answers score more points.

## Authoring questions

Edit `data/questions.json`. Schema:

```json
{
  "questions": [
    {
      "id": "q1",
      "prompt": "Where did the couple first meet?",
      "image": "/assets/images/optional.jpg",
      "choices": ["A", "B", "C", "D"],
      "correctIndex": 2,
      "timeLimitSec": 20
    }
  ]
}
```

- `choices` must have **exactly 4** entries.
- `correctIndex` is 0..3.
- `timeLimitSec` is optional (default 20s, min 3s, max 120s).
- Optional `image` is served from `/assets/images/` (place files under `assets/images/`).

The server validates the file at boot and exits with a clear error if it's malformed.
