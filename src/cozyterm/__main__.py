"""Entry point for CozyTerm: python -m cozyterm"""

from cozyterm.app import CozyTerm


def main() -> None:
    app = CozyTerm()
    app.run()


if __name__ == "__main__":
    main()
