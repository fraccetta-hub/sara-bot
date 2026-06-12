"""
Genera la scheda commerciale Sara Bot in PDF
"""
from reportlab.lib.pagesizes import A4
from reportlab.lib import colors
from reportlab.lib.units import cm
from reportlab.platypus import (
    SimpleDocTemplate, Paragraph, Spacer, Table, TableStyle,
    HRFlowable, KeepTogether
)
from reportlab.lib.styles import ParagraphStyle
from reportlab.lib.enums import TA_LEFT, TA_CENTER, TA_RIGHT
from reportlab.platypus import Flowable

W, H = A4

# ── Colori brand ─────────────────────────────────────────────────────────────
GREEN      = colors.HexColor('#25D366')   # WhatsApp verde
DARK       = colors.HexColor('#1A1A2E')
ACCENT     = colors.HexColor('#16213E')
LIGHT_BG   = colors.HexColor('#F0FFF4')
GRAY       = colors.HexColor('#6B7280')
WHITE      = colors.white
YELLOW     = colors.HexColor('#FCD34D')

# ── Stili ────────────────────────────────────────────────────────────────────
def make_styles():
    return {
        'hero_title': ParagraphStyle('hero_title',
            fontName='Helvetica-Bold', fontSize=32, textColor=WHITE,
            leading=38, alignment=TA_CENTER),
        'hero_sub': ParagraphStyle('hero_sub',
            fontName='Helvetica', fontSize=14, textColor=colors.HexColor('#D1FAE5'),
            leading=20, alignment=TA_CENTER),
        'section_title': ParagraphStyle('section_title',
            fontName='Helvetica-Bold', fontSize=16, textColor=DARK,
            leading=22, spaceBefore=14, spaceAfter=6),
        'body': ParagraphStyle('body',
            fontName='Helvetica', fontSize=11, textColor=DARK,
            leading=17, spaceAfter=4),
        'body_bold': ParagraphStyle('body_bold',
            fontName='Helvetica-Bold', fontSize=11, textColor=DARK,
            leading=17),
        'small': ParagraphStyle('small',
            fontName='Helvetica', fontSize=9, textColor=GRAY, leading=13),
        'price_big': ParagraphStyle('price_big',
            fontName='Helvetica-Bold', fontSize=28, textColor=GREEN,
            leading=34, alignment=TA_CENTER),
        'price_label': ParagraphStyle('price_label',
            fontName='Helvetica', fontSize=11, textColor=GRAY,
            alignment=TA_CENTER),
        'white_bold': ParagraphStyle('white_bold',
            fontName='Helvetica-Bold', fontSize=12, textColor=WHITE,
            leading=16),
        'white': ParagraphStyle('white',
            fontName='Helvetica', fontSize=11, textColor=WHITE,
            leading=16),
        'center': ParagraphStyle('center',
            fontName='Helvetica', fontSize=11, textColor=DARK,
            alignment=TA_CENTER, leading=16),
        'tag': ParagraphStyle('tag',
            fontName='Helvetica-Bold', fontSize=9, textColor=WHITE,
            alignment=TA_CENTER),
        'footer': ParagraphStyle('footer',
            fontName='Helvetica', fontSize=9, textColor=GRAY,
            alignment=TA_CENTER),
        'chat_bubble': ParagraphStyle('chat_bubble',
            fontName='Helvetica', fontSize=10, textColor=DARK,
            leading=14),
        'chat_bubble_me': ParagraphStyle('chat_bubble_me',
            fontName='Helvetica', fontSize=10, textColor=WHITE,
            leading=14),
    }

S = make_styles()

# ── Flowable banner ───────────────────────────────────────────────────────────
class ColorBand(Flowable):
    def __init__(self, height, color, radius=8):
        Flowable.__init__(self)
        self.band_h = height
        self.color  = color
        self.radius = radius
        self.width  = W - 4*cm

    def draw(self):
        self.canv.setFillColor(self.color)
        self.canv.roundRect(0, 0, self.width, self.band_h,
                            self.radius, fill=1, stroke=0)

class ChatDemo(Flowable):
    """Simulazione visiva di una chat WhatsApp"""
    def __init__(self, messages):
        Flowable.__init__(self)
        self.messages = messages   # list of (text, is_me, time)
        self.width  = W - 4*cm
        self.height = len(messages) * 52

    def draw(self):
        c = self.canv
        y = self.height - 10
        for text, is_me, time in self.messages:
            bw = self.width * 0.62
            bh = 38
            if is_me:
                bx = self.width - bw - 4
                c.setFillColor(GREEN)
            else:
                bx = 4
                c.setFillColor(colors.HexColor('#ECECEC'))

            c.roundRect(bx, y - bh, bw, bh, 6, fill=1, stroke=0)

            # testo
            from reportlab.lib.utils import simpleSplit
            style = S['chat_bubble_me'] if is_me else S['chat_bubble']
            lines = simpleSplit(text, style.fontName, style.fontSize, bw - 16)
            ty = y - 14
            for line in lines[:2]:
                c.setFillColor(WHITE if is_me else DARK)
                c.setFont(style.fontName, style.fontSize)
                c.drawString(bx + 8, ty, line)
                ty -= 14

            # orario
            c.setFont('Helvetica', 7)
            c.setFillColor(GRAY)
            c.drawRightString(bx + bw - 6, y - bh + 4, time)

            y -= bh + 10

# ── Builder ───────────────────────────────────────────────────────────────────
def build_pdf(path):
    doc = SimpleDocTemplate(
        path, pagesize=A4,
        leftMargin=2*cm, rightMargin=2*cm,
        topMargin=1.5*cm, bottomMargin=1.5*cm
    )
    story = []
    usable = W - 4*cm

    # ── HERO BANNER ──────────────────────────────────────────────────────────
    hero_data = [[
        Paragraph('🌸 Sara Bot', S['hero_title']),
    ],[
        Paragraph(
            'Tu asistente de ventas por WhatsApp — disponible las 24 horas,<br/>'
            '7 días a la semana, sin sueldos ni feriados.',
            S['hero_sub'])
    ]]
    hero = Table(hero_data, colWidths=[usable])
    hero.setStyle(TableStyle([
        ('BACKGROUND', (0,0), (-1,-1), GREEN),
        ('ROUNDEDCORNERS', [10]),
        ('TOPPADDING',    (0,0), (-1,-1), 22),
        ('BOTTOMPADDING', (0,0), (-1,-1), 22),
        ('LEFTPADDING',   (0,0), (-1,-1), 20),
        ('RIGHTPADDING',  (0,0), (-1,-1), 20),
    ]))
    story.append(hero)
    story.append(Spacer(1, 18))

    # ── PROBLEMA / SOLUCIÓN ──────────────────────────────────────────────────
    story.append(Paragraph('¿Cuánto tiempo perdés respondiendo WhatsApp?', S['section_title']))
    story.append(Paragraph(
        'Precios, disponibilidad, pedidos, horarios… Los mismos mensajes todos los días. '
        'Sara los responde por vos — al instante, siempre con tu tono — '
        'para que vos te concentres en lo importante: <b>tu negocio</b>.',
        S['body']))
    story.append(Spacer(1, 12))
    story.append(HRFlowable(width=usable, color=colors.HexColor('#E5E7EB'), thickness=1))
    story.append(Spacer(1, 12))

    # ── DEMO CHAT ────────────────────────────────────────────────────────────
    story.append(Paragraph('Así responde Sara — en tiempo real', S['section_title']))

    messages = [
        ('Hola, ¿tienen ramos de rosas disponibles?',            False, '10:02'),
        ('¡Hola! 🌹 Sí, tenemos Ramos de Rosas Rojas (12 unid.) a 150.000 Gs. ¿Te mando una foto?', True, '10:02'),
        ('Sí por favor, y si puedo pagar con Billetera Personal', False, '10:03'),
        ('📸 ¡Aquí la foto! Aceptamos Billetera Personal, Claro Pay y transferencia bancaria 😊', True, '10:03'),
        ('Perfecto, lo quiero con entrega hoy a las 18hs',        False, '10:04'),
        ('✅ ¡Listo! Tu pedido fue registrado. Total: 155.000 Gs (incluye envío). Te confirmo en minutos 🚚', True, '10:04'),
    ]
    demo = ChatDemo(messages)
    story.append(demo)
    story.append(Spacer(1, 6))
    story.append(Paragraph('* Simulación. Las respuestas son generadas por inteligencia artificial.', S['small']))
    story.append(Spacer(1, 14))
    story.append(HRFlowable(width=usable, color=colors.HexColor('#E5E7EB'), thickness=1))
    story.append(Spacer(1, 12))

    # ── FUNCIONES ────────────────────────────────────────────────────────────
    story.append(Paragraph('¿Qué hace Sara por tu negocio?', S['section_title']))

    features = [
        ('🤖', 'Responde al instante',
         'Precio, stock, descripción de productos — sin esperas, 24/7.'),
        ('📦', 'Toma pedidos',
         'Confirma productos, cantidades y dirección. El pedido queda registrado automáticamente.'),
        ('📸', 'Muestra fotos',
         'Cuando el cliente pregunta por un producto, Sara envía la foto directo en el chat.'),
        ('🔔', 'Te avisa cada pedido',
         'Recibís un mensaje con todos los detalles y podés confirmar, cancelar o tomar el chat vos mismo.'),
        ('💬', 'Takeover humano',
         'Con un mensaje respondés CHAT y hablás directamente con el cliente. Sara se calla y retoma cuando terminás.'),
        ('💳', 'Info de pago automática',
         'Billetera Personal, Claro Pay, transferencia — las instrucciones se envían solas después de cada pedido.'),
    ]

    feat_rows = []
    for i in range(0, len(features), 2):
        row = []
        for icon, title, desc in features[i:i+2]:
            cell = [
                Paragraph(f'{icon} <b>{title}</b>', S['body_bold']),
                Paragraph(desc, S['body']),
            ]
            row.append(cell)
        if len(row) == 1:
            row.append('')
        feat_rows.append(row)

    feat_table = Table(feat_rows, colWidths=[usable/2 - 6, usable/2 - 6],
                       hAlign='LEFT', spaceBefore=4)
    feat_table.setStyle(TableStyle([
        ('VALIGN',       (0,0), (-1,-1), 'TOP'),
        ('LEFTPADDING',  (0,0), (-1,-1), 8),
        ('RIGHTPADDING', (0,0), (-1,-1), 8),
        ('TOPPADDING',   (0,0), (-1,-1), 8),
        ('BOTTOMPADDING',(0,0), (-1,-1), 8),
        ('BACKGROUND',   (0,0), (-1,-1), LIGHT_BG),
        ('ROUNDEDCORNERS', [6]),
        ('ROWBACKGROUNDS', (0,0), (-1,-1), [LIGHT_BG, colors.HexColor('#E8FFF0')]),
    ]))
    story.append(feat_table)
    story.append(Spacer(1, 16))
    story.append(HRFlowable(width=usable, color=colors.HexColor('#E5E7EB'), thickness=1))
    story.append(Spacer(1, 14))

    # ── PRECIOS ──────────────────────────────────────────────────────────────
    story.append(Paragraph('Planes', S['section_title']))

    plan_data = [
        # Header
        [
            Paragraph('🌱 Básico', S['white_bold']),
            Paragraph('🌸 Profesional', S['white_bold']),
            Paragraph('🏆 Premium', S['white_bold']),
        ],
        [
            Paragraph('150.000 Gs/mes', S['price_big']),
            Paragraph('250.000 Gs/mes', S['price_big']),
            Paragraph('400.000 Gs/mes', S['price_big']),
        ],
        [
            Paragraph('Hasta 300 conversaciones/mes\nCatálogo hasta 20 productos\nNotificaciones de pedidos\nSoporte por WhatsApp', S['white']),
            Paragraph('Hasta 1.000 conversaciones/mes\nCatálogo ilimitado\nFotos de productos\nTakeover humano\nPago integrado', S['white']),
            Paragraph('Conversaciones ilimitadas\nTodo lo del Profesional\nPersonalización avanzada de Sara\nReporte mensual de pedidos\nPrioridad en soporte', S['white']),
        ],
    ]

    plan_table = Table(plan_data,
                       colWidths=[(usable/3)-4]*3,
                       hAlign='CENTER', spaceBefore=6)
    plan_table.setStyle(TableStyle([
        ('BACKGROUND',   (0,0), (-1,0), DARK),
        ('BACKGROUND',   (0,1), (-1,1), ACCENT),
        ('BACKGROUND',   (0,2), (-1,2), colors.HexColor('#0F3460')),
        ('TEXTCOLOR',    (0,0), (-1,-1), WHITE),
        ('ALIGN',        (0,0), (-1,-1), 'CENTER'),
        ('VALIGN',       (0,0), (-1,-1), 'MIDDLE'),
        ('TOPPADDING',   (0,0), (-1,-1), 12),
        ('BOTTOMPADDING',(0,0), (-1,-1), 12),
        ('LEFTPADDING',  (0,0), (-1,-1), 8),
        ('RIGHTPADDING', (0,0), (-1,-1), 8),
        ('LINEAFTER',    (0,0), (1,-1), 1, colors.HexColor('#2D3748')),
        ('ROUNDEDCORNERS', [8]),
        # Highlight centro
        ('BACKGROUND',   (1,0), (1,0), GREEN),
        ('BACKGROUND',   (1,1), (1,1), colors.HexColor('#16A34A')),
        ('BACKGROUND',   (1,2), (1,2), colors.HexColor('#15803D')),
    ]))
    story.append(plan_table)
    story.append(Spacer(1, 6))
    story.append(Paragraph(
        'Todos los planes incluyen configuración inicial y 7 días de prueba gratis.',
        S['small']))
    story.append(Spacer(1, 14))
    story.append(HRFlowable(width=usable, color=colors.HexColor('#E5E7EB'), thickness=1))
    story.append(Spacer(1, 14))

    # ── COMO FUNCIONA ────────────────────────────────────────────────────────
    story.append(Paragraph('¿Cómo empezamos?', S['section_title']))

    steps_data = [
        [Paragraph('1', S['price_big']),
         Paragraph('2', S['price_big']),
         Paragraph('3', S['price_big'])],
        [Paragraph('<b>Cargamos tu catálogo</b><br/>Productos, precios, fotos y descripción.', S['center']),
         Paragraph('<b>Configuramos Sara</b><br/>Con el nombre, personalidad y datos de pago de tu local.', S['center']),
         Paragraph('<b>Activamos el bot</b><br/>En 48 horas tu WhatsApp ya responde solo.', S['center'])],
    ]
    steps = Table(steps_data, colWidths=[(usable/3)-4]*3)
    steps.setStyle(TableStyle([
        ('ALIGN',        (0,0), (-1,-1), 'CENTER'),
        ('VALIGN',       (0,0), (-1,-1), 'MIDDLE'),
        ('TOPPADDING',   (0,0), (-1,-1), 6),
        ('BOTTOMPADDING',(0,0), (-1,-1), 6),
        ('TEXTCOLOR',    (0,0), (-1,0), GREEN),
    ]))
    story.append(steps)
    story.append(Spacer(1, 14))

    # ── CTA ──────────────────────────────────────────────────────────────────
    cta_data = [[
        Paragraph(
            '📲 <b>Probá Sara gratis 7 días — sin compromiso</b><br/>'
            '<font size="11">Escribinos por WhatsApp y lo configuramos juntos</font>',
            ParagraphStyle('cta', fontName='Helvetica-Bold', fontSize=13,
                           textColor=WHITE, alignment=TA_CENTER, leading=20))
    ]]
    cta = Table(cta_data, colWidths=[usable])
    cta.setStyle(TableStyle([
        ('BACKGROUND',   (0,0), (-1,-1), GREEN),
        ('ROUNDEDCORNERS', [10]),
        ('TOPPADDING',   (0,0), (-1,-1), 18),
        ('BOTTOMPADDING',(0,0), (-1,-1), 18),
        ('LEFTPADDING',  (0,0), (-1,-1), 20),
        ('RIGHTPADDING', (0,0), (-1,-1), 20),
    ]))
    story.append(cta)
    story.append(Spacer(1, 10))
    story.append(Paragraph(
        'Sara Bot — Asunción, Paraguay  •  Tecnología WhatsApp Business API + Inteligencia Artificial',
        S['footer']))

    doc.build(story)
    print(f"PDF generado: {path}")

if __name__ == '__main__':
    out = r'C:\Users\Utente\Desktop\Claude1\Sara_Bot_Scheda_Commerciale.pdf'
    build_pdf(out)
