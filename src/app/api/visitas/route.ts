import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'

// GET - Listar visitas
export async function GET() {
  try {
    const visitas = await db.visita.findMany({
      include: { cliente: true },
      orderBy: { createdAt: 'desc' },
      take: 50
    })
    return NextResponse.json(visitas)
  } catch (error) {
    console.error('Error al obtener visitas:', error)
    return NextResponse.json({ error: 'Error al obtener visitas' }, { status: 500 })
  }
}

// POST - Registrar visita manual (desde admin)
export async function POST(request: NextRequest) {
  try {
    const data = await request.json()

    // Crear la visita
    const visita = await db.visita.create({
      data: {
        clienteId: data.clienteId,
        puntosGanados: data.puntosGanados || 1,
        concepto: data.concepto || 'Compra registrada manualmente',
        monto: data.monto,
      }
    })

    // Actualizar puntos y visitas del cliente
    await db.cliente.update({
      where: { id: data.clienteId },
      data: {
        puntos: { increment: data.puntosGanados || 1 },
        totalVisitas: { increment: 1 }
      }
    })

    return NextResponse.json({ 
      success: true, 
      visita,
      mensaje: 'Visita registrada correctamente'
    })
  } catch (error) {
    console.error('Error al registrar visita:', error)
    return NextResponse.json({ error: 'Error al registrar visita' }, { status: 500 })
  }
}
