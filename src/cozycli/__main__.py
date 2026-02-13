"""Entry point for CozyCLI: python -m cozycli"""

from cozycli.app import CozyCLI


def main() -> None:
    app = CozyCLI()
    app.run()


if __name__ == "__main__":
    main()
