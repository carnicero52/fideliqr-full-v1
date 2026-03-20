import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { enviarEmail, enviarRecordatorioCobranza } from '@/lib/email'

// Token de seguridad
const CRON_SECRET = process.env.CRON_SECRET || 'recordatorios-cron-2024'

// GET - Ejecutar tareas programadas ( llamado por Vercel Cron )
export async function GET(request: NextRequest) {
  const startTime = Date.now()

  try {
    // Verificar autorización
    const authHeader = request.headers.get('authorization')
    const urlSecret = request.nextUrl.searchParams.get('secret')
    const providedSecret = authHeader?.replace('Bearer ', '') || urlSecret

    if (providedSecret !== CRON_SECRET) {
      return NextResponse.json({ error: 'No autorizado' }, { status: 401 })
    }

    const resultados = {
      fecha: new Date().toISOString(),
      cobranzasVencidas: 0,
      recordatoriosEnviados: 0,
      campanasProgramadas: 0,
      campanasEnviadas: 0,
      emailsMarketing: 0,
      errores: [] as string[]
    }

    // ==========================================
    // 1. RECORDATORIOS DE COBRANZAS VENCIDAS
    // ==========================================
    try {
      const hoy = new Date()
      hoy.setHours(0, 0, 0, 0)

      // Contar cobranzas vencidas
      resultados.cobranzasVencidas = await db.cobranza.count({
        where: {
          estado: 'pendiente',
          fechaVencimiento: { lt: hoy }
        }
      })

      // Enviar recordatorios
      const cobranzas = await db.cobranza.findMany({
        where: {
          estado: 'pendiente',
          fechaVencimiento: { lt: hoy }
        },
        include: { cliente: true }
      })

      const negocio = await db.negocio.findFirst()
      const nombreNegocio = negocio?.nombre || 'FideliQR'

      for (const cobranza of cobranzas) {
        if (!cobranza.cliente.email) continue

        try {
          await enviarRecordatorioCobranza({
            clienteNombre: cobranza.cliente.nombre,
            clienteEmail: cobranza.cliente.email,
            concepto: cobranza.concepto,
            monto: cobranza.monto,
            fechaVencimiento: cobranza.fechaVencimiento,
            negocioNombre: nombreNegocio,
          })
          resultados.recordatoriosEnviados++
        } catch (e) {
          resultados.errores.push(`Cobranza ${cobranza.id}: ${e}`)
        }
      }

      // Marcar como vencidas las muy antiguas (30+ días)
      const hace30Dias = new Date()
      hace30Dias.setDate(hace30Dias.getDate() - 30)

      await db.cobranza.updateMany({
        where: {
          estado: 'pendiente',
          fechaVencimiento: { lt: hace30Dias }
        },
        data: { estado: 'vencido' }
      })

    } catch (e) {
      resultados.errores.push(`Error cobranzas: ${e}`)
    }

    // ==========================================
    // 2. CAMPAÑAS DE MARKETING PROGRAMADAS
    // ==========================================
    try {
      const ahora = new Date()

      // Buscar campañas programadas para ahora o antes
      const campanas = await db.marketing.findMany({
        where: {
          estado: 'programado',
          fechaProgramada: { lte: ahora }
        }
      })

      resultados.campanasProgramadas = campanas.length

      const negocio = await db.negocio.findFirst()
      const nombreNegocio = negocio?.nombre || 'FideliQR'

      for (const campana of campanas) {
        // Obtener clientes según filtro
        const where = campana.destinatarios === 'inactivos'
          ? { activo: true, totalVisitas: 0 }
          : campana.destinatarios === 'activos'
            ? { activo: true, totalVisitas: { gt: 0 } }
            : { activo: true }

        const clientes = await db.cliente.findMany({
          where,
          select: { email: true, nombre: true }
        })

        let enviados = 0
        let errores = 0

        for (const cliente of clientes) {
          if (!cliente.email) continue

          const html = `
            <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
              <h2 style="color: #059669;">${campana.titulo}</h2>
              <p style="font-size: 16px; line-height: 1.6;">${campana.mensaje.replace(/\n/g, '<br>')}</p>
              <hr style="border: none; border-top: 1px solid #e5e7eb; margin: 30px 0;">
              <p style="color: #6b7280; font-size: 14px; text-align: center;">
                <strong>${nombreNegocio}</strong><br>
                Este mensaje fue enviado a ${cliente.email}
              </p>
            </div>
          `

          const result = await enviarEmail({
            to: cliente.email,
            subject: `${campana.titulo} - ${nombreNegocio}`,
            html,
          })

          if (result.success) {
            enviados++
          } else {
            errores++
          }

          await new Promise(resolve => setTimeout(resolve, 100))
        }

        // Actualizar campaña
        await db.marketing.update({
          where: { id: campana.id },
          data: {
            estado: campana.repetir ? 'programado' : 'enviado',
            enviados,
            errores,
            fechaEnvio: new Date(),
            // Si se repite, programar siguiente fecha
            ...(campana.repetir && campana.fechaProgramada && {
              fechaProgramada: calcularSiguienteFecha(campana.fechaProgramada, campana.repetir)
            })
          }
        })

        resultados.campanasEnviadas++
        resultados.emailsMarketing += enviados
      }

    } catch (e) {
      resultados.errores.push(`Error marketing: ${e}`)
    }

    const duration = Date.now() - startTime

    return NextResponse.json({
      success: true,
      duracion: `${duration}ms`,
      ...resultados
    })

  } catch (error) {
    console.error('Error en cron:', error)
    return NextResponse.json({
      success: false,
      error: String(error),
      fecha: new Date().toISOString()
    }, { status: 500 })
  }
}

// Calcular siguiente fecha según repetición
function calcularSiguienteFecha(fecha: Date, repetir: string): Date {
  const nueva = new Date(fecha)

  switch (repetir) {
    case 'diario':
      nueva.setDate(nueva.getDate() + 1)
      break
    case 'semanal':
      nueva.setDate(nueva.getDate() + 7)
      break
    case 'mensual':
      nueva.setMonth(nueva.getMonth() + 1)
      break
  }

  return nueva
}
