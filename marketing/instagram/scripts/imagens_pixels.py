"""Pixel work for the image engine: Instagram-ready JPEGs and review contact sheets.

Runs on the Python that ships with the mflux tool (it already has Pillow), so the
engine needs nothing beyond `uv tool install mflux`. Called by imagens.ts; not meant
to be used by hand.

  finalizar <entrada> <saida.jpg> <largura> <altura>
  folha <saida.jpg> <titulo> <colunas> <rotulo=caminho> ...
  verificar <arquivo.jpg>
"""

import io
import json
import sys

from PIL import Image, ImageCms, ImageDraw, ImageFont

LIMITE_BYTES = 8 * 1024 * 1024
SRGB = ImageCms.ImageCmsProfile(ImageCms.createProfile("sRGB"))
SRGB_BYTES = SRGB.tobytes()


# A fonte embutida do Pillow não tem acentos; usa uma do sistema quando houver.
FONTES = ("/System/Library/Fonts/Supplemental/Arial.ttf", "/System/Library/Fonts/Helvetica.ttc", "DejaVuSans.ttf")


def fonte(tamanho: int):
    for caminho in FONTES:
        try:
            return ImageFont.truetype(caminho, tamanho)
        except OSError:
            continue
    return ImageFont.load_default(size=tamanho)


def para_srgb(imagem: Image.Image) -> Image.Image:
    icc = imagem.info.get("icc_profile")
    imagem = imagem.convert("RGB")
    if icc:
        origem = ImageCms.ImageCmsProfile(io.BytesIO(icc))
        imagem = ImageCms.profileToProfile(imagem, origem, SRGB, outputMode="RGB")
    return imagem


def cobrir(imagem: Image.Image, largura: int, altura: int) -> Image.Image:
    escala = max(largura / imagem.width, altura / imagem.height)
    tamanho = (round(imagem.width * escala), round(imagem.height * escala))
    imagem = imagem.resize(tamanho, Image.Resampling.LANCZOS)
    x = (imagem.width - largura) // 2
    y = (imagem.height - altura) // 2
    return imagem.crop((x, y, x + largura, y + altura))


def salvar_jpeg(imagem: Image.Image, saida: str) -> int:
    for qualidade in (92, 88, 84, 80, 75, 70):
        buffer = io.BytesIO()
        imagem.save(buffer, "JPEG", quality=qualidade, optimize=True, progressive=True, icc_profile=SRGB_BYTES)
        if buffer.tell() < LIMITE_BYTES:
            with open(saida, "wb") as arquivo:
                arquivo.write(buffer.getvalue())
            return qualidade
    raise SystemExit(f"{saida}: não ficou abaixo de 8 MB nem com qualidade 70")


def finalizar(entrada: str, saida: str, largura: str, altura: str) -> None:
    imagem = cobrir(para_srgb(Image.open(entrada)), int(largura), int(altura))
    qualidade = salvar_jpeg(imagem, saida)
    print(json.dumps({"qualidade": qualidade}))


def folha(saida: str, titulo: str, colunas: str, *itens: str) -> None:
    colunas_n = int(colunas)
    largura_miniatura = 360
    pares = [item.split("=", 1) for item in itens]
    miniaturas = []
    for rotulo, caminho in pares:
        imagem = Image.open(caminho).convert("RGB")
        altura = round(imagem.height * largura_miniatura / imagem.width)
        miniaturas.append((rotulo, imagem.resize((largura_miniatura, altura), Image.Resampling.LANCZOS)))
    altura_miniatura = max(imagem.height for _, imagem in miniaturas)
    margem, faixa, cabecalho = 16, 34, 56
    linhas = -(-len(miniaturas) // colunas_n)
    folha_img = Image.new(
        "RGB",
        (margem + colunas_n * (largura_miniatura + margem), cabecalho + linhas * (altura_miniatura + faixa + margem)),
        "white",
    )
    desenho = ImageDraw.Draw(folha_img)
    desenho.text((margem, 16), titulo, fill="black", font=fonte(22))
    fonte_rotulo = fonte(18)
    for indice, (rotulo, imagem) in enumerate(miniaturas):
        linha, coluna = divmod(indice, colunas_n)
        x = margem + coluna * (largura_miniatura + margem)
        y = cabecalho + linha * (altura_miniatura + faixa + margem)
        desenho.text((x, y + 6), rotulo, fill="black", font=fonte_rotulo)
        folha_img.paste(imagem, (x, y + faixa))
    salvar_jpeg(folha_img, saida)


def verificar(caminho: str) -> None:
    imagem = Image.open(caminho)
    icc = imagem.info.get("icc_profile")
    descricao = ImageCms.getProfileDescription(ImageCms.ImageCmsProfile(io.BytesIO(icc))).strip() if icc else None
    with open(caminho, "rb") as arquivo:
        tamanho = len(arquivo.read())
    print(
        json.dumps(
            {"formato": imagem.format, "largura": imagem.width, "altura": imagem.height, "modo": imagem.mode, "icc": descricao, "bytes": tamanho}
        )
    )


if __name__ == "__main__":
    comandos = {"finalizar": finalizar, "folha": folha, "verificar": verificar}
    if len(sys.argv) < 2 or sys.argv[1] not in comandos:
        raise SystemExit(__doc__)
    comandos[sys.argv[1]](*sys.argv[2:])
