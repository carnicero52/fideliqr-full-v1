import { NextRequest, NextResponse } from 'next/server'
import { enviarEmail } from '@/lib/email'
import { db } from '@/lib/db'

// Token de seguridad para verificar que es un cron job legítimo
const CRON_SECRET = process.env.CRON_SECRET || 'fideliqr-cron-secret-2024'

// GET - Procesar recordatorios automáticos de cobranzas
// Este endpoint debe ser llamado por cron-job.org diariamente
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
      cobranzasProximasAVencer: 0,
      cobranzasVencidas: 0,
      recordatoriosEnviados: 0,
      errores: [] as string[]
    }

    // Obtener configuración
    const config = await db.configuracion.findFirst()
    const negocio = await db.negocio.findFirst()
    
    if (!config?.recordatoriosAutomaticos) {
      return NextResponse.json({
        success: true,
        mensaje: 'Recordatorios automáticos desactivados',
        fecha: new Date().toISOString()
      })
    }

    const diasAntes = config.diasRecordatorio || 3
    const diasDespues = config.diasRecordatorioVencido || 7
    const nombreNegocio = negocio?.nombre || 'FideliQR'

    const hoy = new Date()
    hoy.setHours(0, 0, 0, 0)

    // 1. Cobranzas próximas a vencer (enviar recordatorio X días antes)
    const fechaLimite = new Date(hoy)
    fechaLimite.setDate(fechaLimite.getDate() + diasAntes)

    const cobranzasProximas = await db.cobranza.findMany({
      where: {
        estado: 'pendiente',
        fechaVencimiento: {
          gte: hoy,
          lte: fechaLimite
        }
      },
      include: { cliente: true }
    })

    resultados.cobranzasProximasAVencer = cobranzasProximas.length

    for (const cobranza of cobranzasProximas) {
      if (!cobranza.cliente.email) continue
      
      try {
        const diasRestantes = Math.ceil(
          (new Date(cobranza.fechaVencimiento!).getTime() - hoy.getTime()) / (1000 * 60 * 60 * 24)
        )

        await enviarEmail({
          to: cobranza.cliente.email,
          subject: `⏰ Recordatorio: Pago próximo a vencer - ${nombreNegocio}`,
          html: `
            <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
              <h2 style="color: #f59e0b;">⏰ Recordatorio de Pago Próximo</h2>
              <p>Hola ${cobranza.cliente.nombre},</p>
              <p>Tienes un pago que vence en <strong>${diasRestantes} días</strong>.</p>
              
              <div style="background: #fef3c7; padding: 20px; border-radius: 10px; margin: 20px 0;">
                <p style="margin: 0; color: #6b7280;">Concepto:</p>
                <p style="font-size: 18px; font-weight: bold; margin: 5px 0;">${cobranza.concepto}</p>
                <p style="margin: 15px 0 0 0; color: #6b7280;">Monto:</p>
                <p style="font-size: 28px; font-weight: bold; color: #f59e0b; margin: 5px 0;">$${cobranza.monto.toFixed(2)}</p>
                <p style="color: #6b7280;">Vence: ${new Date(cobranza.fechaVencimiento!).toLocaleDateString('es-ES')}</p>
              </div>

              <p>Por favor, realiza tu pago a tiempo para evitar recargos.</p>
              
              <p style="color: #6b7280; font-size: 14px; margin-top: 30px;">
                <strong>${nombreNegocio}</strong><br>
                Este es un recordatorio automático.
              </p>
            </div>
          `
        })
        resultados.recordatoriosEnviados++
      } catch (error) {
        resultados.errores.push(`Error enviando a ${cobranza.cliente.email}: ${error}`)
      }
    }

    // 2. Cobranzas vencidas (recordar cada X días)
    const cobranzasVencidas = await db.cobranza.findMany({
      where: {
        estado: 'pendiente',
        fechaVencimiento: {
          lt: hoy
        }
      },
      include: { cliente: true }
    })

    resultados.cobranzasVencidas = cobranzasVencidas.length

    for (const cobranza of cobranzasVencidas) {
      if (!cobranza.cliente.email) continue
      
      // Calcular días vencidos
      const diasVencidos = Math.floor(
        (hoy.getTime() - new Date(cobranza.fechaVencimiento!).getTime()) / (1000 * 60 * 60 * 24)
      )

      // Solo enviar si es múltiplo de diasDespues (ej: cada 7 días)
      if (diasVencidos % diasDespues !== 0) continue

      try {
        await enviarEmail({
          to: cobranza.cliente.email,
          subject: `🚨 Pago Vencido - ${nombreNegocio}`,
          html: `
            <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
              <h2 style="color: #dc2626;">🚨 Pago Vencido</h2>
              <p>Hola ${cobranza.cliente.nombre},</p>
              <p>Tienes un pago vencido hace <strong>${diasVencidos} días</strong>.</p>
              
              <div style="background: #fef2f2; border: 2px solid #fca5a5; padding: 20px; border-radius: 10px; margin: 20px 0;">
                <p style="margin: 0; color: #6b7280;">Concepto:</p>
                <p style="font-size: 18px; font-weight: bold; margin: 5px 0;">${cobranza.concepto}</p>
                <p style="margin: 15px 0 0 0; color: #6b7280;">Monto:</p>
                <p style="font-size: 32px; font-weight: bold; color: #dc2626; margin: 5px 0;">$${cobranza.monto.toFixed(2)}</p>
              </div>

              <p><strong>Por favor, regulariza tu situación lo antes posible.</strong></p>
              
              <p style="color: #6b7280; font-size: 14px; margin-top: 30px;">
                <strong>${nombreNegocio}</strong><br>
                Este es un recordatorio automático.
              </p>
            </div>
          `
        })
        resultados.recordatoriosEnviados++
      } catch (error) {
        resultados.errores.push(`Error enviando a ${cobranza.cliente.email}: ${error}`)
      }
    }

    const duration = Date.now() - startTime

    return NextResponse.json({
      success: true,
      fecha: new Date().toISOString(),
      duracion: `${duration}ms`,
      configuracion: {
        diasAntes,
        diasDespues,
        activo: config.recordatoriosAutomaticos
      },
      ...resultados
    })

  } catch (error) {
    console.error('Error en cron de cobranzas:', error)
    return NextResponse.json({ 
      success: false, 
      error: String(error),
      fecha: new Date().toISOString()
    }, { status: 500 })
  }
}
