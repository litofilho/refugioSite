import { Shield, Target, Zap, CheckCircle, ArrowRight } from 'lucide-react';
import { Button } from './components/ui/button';
import { Card } from './components/ui/card';
// @ts-ignore
import logo from '../../public/imgs/refugio.svg';

export default function App() {
  return (
    <div className="min-h-screen bg-background">
      {/* Header */}
      <header className="border-b border-border">
        <div className="max-w-7xl mx-auto px-6 py-6 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <img src={logo} alt="Refúgio Tech" className="h-12 w-12" />
            <span className="logo_font">REFUGIO TECH</span>
          </div>
        </div>
      </header>

      {/* Hero Section */}
      <section className="hero_bg py-32 px-6">
        <div className="max-w-5xl mx-auto text-center">
          <h1 className="text-5xl md:text-6xl font-bold mb-8 text-secondary tracking-tight leading-tight">
            SEUS PROCESSOS SÃO UM CAOS MANUAL?<br />
            NÓS CONSTRUÍMOS A SOLIDEZ<br />
            OPERACIONAL EM 30 DIAS.
          </h1>
          <p className="text-xl text-muted-foreground mb-12 max-w-3xl mx-auto leading-relaxed">
            Intervenção especializada e definitiva para eliminar sua maior fonte de retrabalho
          </p>
          <div className="flex flex-col sm:flex-row gap-4 justify-center">
            <Button 
              size="lg" 
              className="bg-accent text-accent-foreground hover:bg-accent/90 px-8 py-6 text-lg"
            >
              Agendar Briefing de 30 Minutos
              <ArrowRight className="ml-2 h-5 w-5" />
            </Button>
          </div>
        </div>
      </section>

      {/* Product Section - Refúgio Base */}
      <section className="py-32 px-6 refugio_base_bg">
        <div className="max-w-5xl mx-auto">
          <div className="text-center mb-16">
            <h1 className="text-5xl text-white font-bold mb-6">Refúgio Base</h1>
            <p className="text-xl text-white text-muted-foreground leading-relaxed max-w-3xl mx-auto">
              Automação de UM Ponto de Dor Crítico — Intervenção Cirúrgica e Definitiva
            </p>
          </div>

          <Card className="p-12 border-2 border-primary">
            <div className="grid md:grid-cols-2 gap-12">
              <div>
                <h3 className="text-3xl font-bold mb-6 text-secondary">O Que Você Recebe</h3>
                <ul className="space-y-4">
                  {[
                    'Sistema web robusto focado em 1 processo crítico',
                    'Integração com suas ferramentas existentes',
                    'Arquitetura antifrágil pronta para escalar',
                    'Documentação técnica completa',
                    'Treinamento da equipe incluído',
                    'Garantia de 30 dias pós-entrega'
                  ].map((item, index) => (
                    <li key={index} className="flex items-start gap-3">
                      <CheckCircle className="h-6 w-6 text-primary flex-shrink-0 mt-0.5" />
                      <span className="text-lg leading-relaxed">{item}</span>
                    </li>
                  ))}
                </ul>
              </div>
              <div className="flex flex-col justify-center items-center text-center p-8 bg-primary/5 rounded-lg">
                <div className="mb-6">
                  <div className="text-5xl font-bold text-secondary mb-2">R$ 16.500</div>
                  <p className="text-lg text-muted-foreground">Preço Fixo</p>
                </div>
                <div className="mb-8">
                  <div className="text-4xl font-bold text-secondary mb-2">30 dias</div>
                  <p className="text-lg text-muted-foreground">Entrega Garantida</p>
                </div>
                <Button 
                  size="lg" 
                  className="bg-accent text-accent-foreground hover:bg-accent/90 w-full py-6"
                >
                  Iniciar Agora
                  <ArrowRight className="ml-2 h-5 w-5" />
                </Button>
              </div>
            </div>
          </Card>
        </div>
      </section>

      {/* Three Pillars */}
      <section className="py-32 px-6 bg-gray-50">
        <div className="max-w-6xl mx-auto">
          <h2 className="text-4xl font-bold text-center mb-16 text-secondary">
            Os 3 Pilares da Refúgio Tech
          </h2>
          <div className="grid md:grid-cols-3 gap-12">
            <div className="text-center">
              <div className="inline-flex items-center justify-center w-20 h-20 bg-primary rounded-lg mb-6">
                <Shield className="h-10 w-10 text-white" />
              </div>
              <h3 className="text-2xl font-bold mb-4 text-secondary">Antifragilidade</h3>
              <p className="text-lg leading-relaxed text-muted-foreground">
                Sistemas que não apenas resistem ao caos, mas prosperam sob pressão. 
                Construímos soluções que melhoram com o uso e se adaptam a mudanças inevitáveis.
              </p>
            </div>
            <div className="text-center">
              <div className="inline-flex items-center justify-center w-20 h-20 bg-secondary rounded-lg mb-6">
                <Target className="h-10 w-10 text-white" />
              </div>
              <h3 className="text-2xl font-bold mb-4 text-secondary">Maestria Boutique</h3>
              <p className="text-lg leading-relaxed text-muted-foreground">
                Não somos uma consultoria generalista. Somos especialistas focados em entregar 
                qualidade de elite para PMEs que valorizam excelência técnica.
              </p>
            </div>
            <div className="text-center">
              <div className="inline-flex items-center justify-center w-20 h-20 bg-accent rounded-lg mb-6">
                <Zap className="h-10 w-10 text-accent-foreground" />
              </div>
              <h3 className="text-2xl font-bold mb-4 text-secondary">Vanguarda Estratégica</h3>
              <p className="text-lg leading-relaxed text-muted-foreground">
                Inovação fundamentada em arquitetura sólida. Não seguimos modismos — 
                aplicamos tecnologias comprovadas de forma estratégica e sustentável.
              </p>
            </div>
          </div>
        </div>
      </section>

      {/* Process Section */}
      <section className="py-32 px-6">
        <div className="max-w-5xl mx-auto">
          <h2 className="text-4xl font-bold text-center mb-16 text-secondary">
            Nosso Processo Rigoroso
          </h2>
          <div className="space-y-8">
            {[
              {
                step: '01',
                title: 'Briefing de Filtro',
                description: 'Sessão de 30 minutos para entender seu contexto e validar se há fit estratégico. Rejeitamos projetos que não se alinham à nossa expertise.'
              },
              {
                step: '02',
                title: 'Contrato e Alinhamento',
                description: 'Definição clara de escopo, preço fixo e cronograma. Zero surpresas, total transparência desde o início.'
              },
              {
                step: '03',
                title: 'Diagnóstico e Blueprint',
                description: 'Mapeamento técnico profundo do processo crítico. Criamos o blueprint arquitetural da solução antifrágil.'
              },
              {
                step: '04',
                title: 'Aprovação Técnica',
                description: 'Validação do blueprint com você antes de escrever uma linha de código. Garantimos alinhamento total da solução.'
              },
              {
                step: '05',
                title: 'Execução Antifrágil',
                description: 'Desenvolvimento iterativo com checkpoints semanais. Entrega em até 30 dias com treinamento e documentação completa.'
              }
            ].map((item, index) => (
              <Card key={index} className="p-8 border-l-4 border-l-primary hover:shadow-lg transition-shadow">
                <div className="flex gap-6">
                  <div className="text-5xl font-bold text-primary/30">{item.step}</div>
                  <div>
                    <h3 className="text-2xl font-bold mb-3 text-secondary">{item.title}</h3>
                    <p className="text-lg leading-relaxed text-muted-foreground">{item.description}</p>
                  </div>
                </div>
              </Card>
            ))}
          </div>
        </div>
      </section>

      {/* CTA Section */}
      <section className="py-32 px-6 bg-secondary text-secondary-foreground">
        <div className="max-w-4xl mx-auto text-center">
          <h2 className="text-5xl font-bold mb-8">
            Pronto Para Eliminar o Caos?
          </h2>
          <p className="text-xl mb-12 leading-relaxed">
            Agende agora seu briefing inicial de 30 minutos. Sem compromisso, 
            apenas uma conversa estratégica sobre como podemos resolver seu maior ponto de dor operacional.
          </p>
          <Button 
            size="lg" 
            className="bg-accent text-accent-foreground hover:bg-accent/90 px-12 py-8 text-xl"
          >
            Solicitar Agora o Briefing Inicial
            <ArrowRight className="ml-3 h-6 w-6" />
          </Button>
        </div>
      </section>

      {/* Founders Section */}
      <section className="py-32 px-6">
        <div className="max-w-6xl mx-auto">
          <h2 className="text-4xl font-bold text-center mb-16 text-secondary">
            Fundado por Engenheiros de Elite
          </h2>
          <div className="grid md:grid-cols-3 gap-12">
            {[
              {
                name: 'Carlos Coelho',
                role: 'Tech Lead',
                description: 'Especialista em arquitetura de sistemas robustos e escaláveis'
              },
              {
                name: 'Lucas Pessoa',
                role: 'Gerente de Engenharia',
                description: 'Focado em processos antifrágeis e gestão de qualidade técnica'
              },
              {
                name: 'Felipe Batista',
                role: 'Principal Engineer',
                description: 'Vanguarda tecnológica com fundamento em engenharia sólida'
              }
            ].map((founder, index) => (
              <Card key={index} className="p-8 text-center hover:shadow-lg transition-shadow">
                <div className="w-24 h-24 bg-primary/20 rounded-full mx-auto mb-6 flex items-center justify-center">
                  <span className="text-3xl font-bold text-primary">
                    {founder.name.split(' ').map(n => n[0]).join('')}
                  </span>
                </div>
                <h3 className="text-xl font-bold mb-2 text-secondary">{founder.name}</h3>
                <p className="text-accent font-semibold mb-4">{founder.role}</p>
                <p className="text-muted-foreground leading-relaxed">{founder.description}</p>
              </Card>
            ))}
          </div>
        </div>
      </section>

      {/* Footer */}
      <footer className="border-t border-border py-12 px-6 bg-gray-50">
        <div className="max-w-7xl mx-auto">
          <div className="flex flex-col md:flex-row items-center justify-between gap-6 mb-8">
            <div className="flex items-center gap-3">
              <img src={logo} alt="Refúgio Tech" className="h-10 w-10" />
              <span className="logo_font">REFUGIO TECH</span>
            </div>
            <Button 
              className="bg-accent text-accent-foreground hover:bg-accent/90"
            >
              Contato
            </Button>
          </div>
          <div className="border-t border-border pt-8 text-center">
            <p className="text-lg text-muted-foreground leading-relaxed italic">
              "Refúgio Tech: Não somos apenas consultoria.<br />
              Somos o fundamento sólido para a sua Transformação Tecnológica."
            </p>
            <p className="text-sm text-muted-foreground mt-6">
              © 2026 Refúgio Tech. Todos os direitos reservados.
            </p>
          </div>
        </div>
      </footer>
    </div>
  );
}